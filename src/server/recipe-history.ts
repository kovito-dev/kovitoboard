/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe history — read/write .kovitoboard/recipe-history.jsonl
 */
import { recipeLogger } from './logger'
import { join } from 'path'
import type { FileAccessLayer } from './fs-layer'
import { getKovitoboardDir } from './paths'
import type { RecipeHistoryEntry } from '../shared/recipe-types'

const HISTORY_FILENAME = 'recipe-history.jsonl'

/** Get the path to the recipe history JSONL file. */
export function getRecipeHistoryPath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), HISTORY_FILENAME)
}

/**
 * Maximum per-call warning lines emitted for parse failures. Beyond
 * this we collapse the rest into a single summary line so a corrupted
 * (or hostile) JSONL file cannot turn every read into a log spam +
 * CPU storm.
 */
const MAX_PARSE_WARNINGS = 10

/**
 * Fraction of non-empty lines that must parse successfully for the
 * file to be considered "mostly OK". Below this we rotate the file to
 * `.corrupted` so the next append starts fresh, rather than re-reading
 * and re-warning on every call.
 */
const CORRUPTION_ROTATE_THRESHOLD = 0.5

/**
 * Minimum absolute number of parse failures before we consider
 * whole-file rotation. Keeps small histories (e.g. one valid line +
 * one truncated trailing line) from being rotated and "losing" their
 * recoverable entries to the `.corrupted` archive.
 */
const MIN_FAILURES_TO_ROTATE = 5

/**
 * Hard size cap for the JSONL store before we treat the file as
 * unreadable and rotate it. Without this a single oversized file
 * (corrupted, hostile, or accidentally appended-to in a tight loop)
 * can stall the event loop for the duration of a synchronous
 * `readFileSync` + `JSON.parse` of every line.
 *
 * 10 MiB lets a recipe-history file accumulate well past normal
 * lifetime usage (each entry is well under 1 KiB) before this trips.
 */
const MAX_HISTORY_BYTES = 10 * 1024 * 1024

/**
 * Per-line size cap for `appendRecipeHistory`. POSIX `write(2)`
 * is atomic-with-respect-to-other-writers only for payloads up to
 * `PIPE_BUF` (4 KiB on Linux). Beyond that, two concurrent appends
 * could be split into multiple syscalls and interleave their bytes,
 * corrupting the JSONL store the same way the old read-modify-write
 * loop did.
 *
 * 4 KiB is generous for a real `RecipeHistoryEntry` — typical
 * payloads are a few hundred bytes — so the cap functions as an
 * abuse / accident guard rather than a normal-path limit. Callers
 * that need to record larger artefacts should reference them by
 * path / hash instead of inlining their bodies into the history.
 */
const MAX_ENTRY_BYTES = 4 * 1024

/**
 * Minimum runtime guard for a `RecipeHistoryEntry` shape. Catches a
 * syntactically valid JSON line that does not carry the required
 * fields — a `JSON.parse(line) as RecipeHistoryEntry` cast alone
 * would otherwise let `null`, arrays, or arbitrary objects flow into
 * the returned history array and break callers that assume the
 * shape. Optional fields (`action`, `author`, etc.) are not enforced
 * here because legacy entries written before those fields existed
 * must still be readable; the schema doc on `RecipeHistoryEntry`
 * defines the read-side defaults.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecipeHistoryEntry(obj: unknown): obj is RecipeHistoryEntry {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return false
  }
  const o = obj as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.version === 'string' &&
    typeof o.source === 'string' &&
    typeof o.hash === 'string' &&
    typeof o.appliedAt === 'string' &&
    isStringArray(o.artifacts) &&
    isStringArray(o.menu)
  )
}

/**
 * Build a unique archive path for a corrupted/oversized history file.
 * Without a timestamp suffix two consecutive corruption events would
 * silently overwrite the previous `.corrupted` archive, destroying
 * forensic data and any chance of recovering older entries by hand.
 *
 * Format: `<path>.corrupted.<YYYYMMDDHHmmssSSS>` (UTC, no separators
 * so it sorts lexically and survives copying across filesystems).
 */
function makeCorruptedArchivePath(basePath: string): string {
  const now = new Date()
  const stamp =
    now.getUTCFullYear().toString().padStart(4, '0') +
    (now.getUTCMonth() + 1).toString().padStart(2, '0') +
    now.getUTCDate().toString().padStart(2, '0') +
    now.getUTCHours().toString().padStart(2, '0') +
    now.getUTCMinutes().toString().padStart(2, '0') +
    now.getUTCSeconds().toString().padStart(2, '0') +
    now.getUTCMilliseconds().toString().padStart(3, '0')
  return `${basePath}.corrupted.${stamp}`
}

/**
 * Read all recipe history entries. Returns an empty array when the file
 * does not exist.
 *
 * Per-line parsing: a single corrupted line (e.g. a half-written entry
 * left by a crashed process before this module switched to
 * `appendFileSync`) is logged and skipped rather than failing the
 * whole read. The first `MAX_PARSE_WARNINGS` failures are logged
 * verbatim; any beyond that contribute only to a single summary line.
 *
 * Whole-file rotation: if at least half of the non-empty lines fail
 * to parse, the file is renamed to `<path>.corrupted` and an empty
 * history is returned. The next `appendRecipeHistory` call then
 * starts a fresh file, which prevents an unbounded growth of bad
 * lines that we would otherwise reprocess on every read.
 */
export function readRecipeHistory(fs: FileAccessLayer): RecipeHistoryEntry[] {
  const path = getRecipeHistoryPath(fs)
  if (!fs.existsSync(path)) return []

  // Size gate: bail out before reading or parsing oversized files.
  // The synchronous read + per-line parse below can starve the event
  // loop on a multi-megabyte file; since legitimate histories never
  // approach this limit, it is safer to rotate and start fresh than
  // to honour an unbounded read.
  let size = 0
  try {
    size = fs.statSync(path).size
  } catch (err) {
    recipeLogger.error({ err }, '[recipe-history] Failed to stat history file')
    return []
  }
  if (enforceHistorySizeGate(fs, path, size)) {
    return []
  }

  let content: string
  try {
    content = fs.readFileSync(path, 'utf-8')
  } catch (err) {
    recipeLogger.error({ err }, '[recipe-history] Failed to read history:')
    return []
  }

  return parseRecipeHistoryContent(fs, content)
}

/**
 * Enforce the `MAX_HISTORY_BYTES` cap on `recipe-history.jsonl`.
 * Returns `true` if the file was over-cap (and an attempt was made
 * to rotate it to `.corrupted.<ts>`), so the caller knows to abort
 * the read and treat the active history as empty. Returns `false`
 * when the file is within budget and the caller may proceed to
 * `readFileSync` + parse.
 *
 * The size cap exists because the synchronous read + per-line
 * parse on the request path can starve the Express event loop on
 * multi-megabyte files. Both `readRecipeHistory` (best-effort) and
 * `loadRecipeHistorySnapshot` (throwing IO contract) call this
 * helper so the DoS guard applies uniformly to every reader (PR
 * #56 codex attempt 5 Finding "resource exhaustion" — the snapshot
 * loader previously skipped the gate after the attempt 4 refactor
 * collapsed the probe + parse into a single function).
 *
 * Rotation failures are logged but do not surface to the caller:
 * the size cap is a defensive ceiling, not a correctness invariant,
 * so a failed rename should not block the request — the caller
 * simply walks away from the over-cap file and the next append
 * starts a fresh one.
 */
export function enforceHistorySizeGate(
  fs: FileAccessLayer,
  path: string,
  size: number,
): boolean {
  if (size <= MAX_HISTORY_BYTES) return false
  const corruptedPath = makeCorruptedArchivePath(path)
  try {
    fs.renameSync(path, corruptedPath)
    recipeLogger.error(
      `[recipe-history] File size ${size} bytes exceeds ${MAX_HISTORY_BYTES} byte cap; rotated to ${corruptedPath}.`,
    )
  } catch (err) {
    recipeLogger.error(
      { err },
      '[recipe-history] Failed to rotate oversized history file',
    )
  }
  return true
}

/**
 * Parse + validate a pre-loaded recipe-history.jsonl payload and
 * apply the corruption-rotate self-heal rule. Exposed so callers
 * with a throwing IO contract (`loadRecipeHistorySnapshot` in
 * `bundled-installer.ts`) can read the file exactly once and reuse
 * the parsed entries without re-running `readFileSync` (PR #56
 * codex attempt 4 Finding "sync I/O amplification"). The rotation
 * logic mirrors `readRecipeHistory` so both call paths share the
 * same self-heal behaviour on corruption.
 */
export function parseRecipeHistoryContent(
  fs: FileAccessLayer,
  content: string,
): RecipeHistoryEntry[] {
  const path = getRecipeHistoryPath(fs)
  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const entries: RecipeHistoryEntry[] = []
  // Both syntax errors *and* shape mismatches count toward the
  // failure tally — schema-violating entries are just as load-
  // bearing for downstream code as unparseable garbage, and treating
  // them the same simplifies the rotation rule.
  let parseFailures = 0
  let warnedCount = 0
  const reportLineIssue = (reason: string): void => {
    parseFailures += 1
    if (warnedCount < MAX_PARSE_WARNINGS) {
      recipeLogger.warn(`[recipe-history] Skipping unusable line: ${reason}`)
      warnedCount += 1
    }
  }
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      reportLineIssue(err instanceof Error ? err.message : String(err))
      continue
    }
    if (!isRecipeHistoryEntry(parsed)) {
      reportLineIssue('does not match RecipeHistoryEntry shape')
      continue
    }
    entries.push(parsed)
  }
  if (parseFailures > MAX_PARSE_WARNINGS) {
    recipeLogger.warn(
      `[recipe-history] Suppressed ${parseFailures - MAX_PARSE_WARNINGS} additional parse warnings (corruption suspected).`,
    )
  }

  // Whole-file rotation: only when corruption is *both* widespread
  // (>= CORRUPTION_ROTATE_THRESHOLD) *and* numerous in absolute terms
  // (>= MIN_FAILURES_TO_ROTATE). Without the absolute floor, a tiny
  // history (e.g. one valid entry + one truncated trailing line)
  // would trip 50% on its own and lose the recoverable entry to the
  // `.corrupted` archive. The entries we *did* manage to parse are
  // intentionally returned even when we do rotate, so callers see
  // continuity instead of an empty slate.
  const failureRatio = lines.length > 0 ? parseFailures / lines.length : 0
  if (
    parseFailures >= MIN_FAILURES_TO_ROTATE &&
    failureRatio >= CORRUPTION_ROTATE_THRESHOLD
  ) {
    const corruptedPath = makeCorruptedArchivePath(path)
    try {
      fs.renameSync(path, corruptedPath)
      recipeLogger.error(
        `[recipe-history] Corruption ratio ${(failureRatio * 100).toFixed(0)}% (${parseFailures}/${lines.length}); rotated to ${corruptedPath}.`,
      )
      // Rewrite the recoverable entries to a fresh history file. The
      // first call after rotation already returns them to the caller
      // via `entries`, but without this rewrite the *next* read would
      // see no file at all and the recovered entries would silently
      // disappear from the active store on process restart.
      if (entries.length > 0) {
        const recoveredContent =
          entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        try {
          fs.writeFileAtomic(path, recoveredContent)
          recipeLogger.error(
            `[recipe-history] Recovered ${entries.length} valid entries into a fresh history file.`,
          )
        } catch (writeErr) {
          recipeLogger.error(
            { err: writeErr },
            '[recipe-history] Failed to rewrite recovered entries',
          )
        }
      }
    } catch (err) {
      recipeLogger.error(
        { err },
        '[recipe-history] Failed to rename corrupted history file',
      )
    }
  }

  return entries
}

/**
 * Append a single history entry to the JSONL file.
 *
 * Implementation note: this used to read the entire file, concatenate
 * the new line, and `writeFileSync` it back — a read-modify-write
 * cycle that lost entries when two callers raced and that could leave
 * a half-written file behind on a crash. The current implementation
 * uses `appendFileSync`, which on POSIX is a single `write(2)` for
 * short payloads (<= `PIPE_BUF`, 4 KiB on Linux) and therefore atomic
 * with respect to other concurrent appends to the same file.
 *
 * Payloads larger than `MAX_ENTRY_BYTES` would risk being split into
 * multiple `write(2)` calls and could interleave with concurrent
 * appends, so they are rejected outright. Real recipe entries fit
 * comfortably within the cap; artefacts that would exceed it should
 * be recorded by reference (path / hash) rather than inlined.
 */
export function appendRecipeHistory(fs: FileAccessLayer, entry: RecipeHistoryEntry): void {
  const path = getRecipeHistoryPath(fs)
  const dir = getKovitoboardDir(fs)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const line = JSON.stringify(entry) + '\n'
  const lineSize = Buffer.byteLength(line, 'utf-8')
  if (lineSize > MAX_ENTRY_BYTES) {
    throw new Error(
      `recipe history entry size ${lineSize} bytes exceeds ${MAX_ENTRY_BYTES} byte cap; record large artefacts by reference instead`,
    )
  }
  fs.appendFileSync(path, line, 'utf-8')
}

/**
 * Generate a unique history ID in the format r_YYYYMMDD_NNN.
 * NNN is a zero-padded sequence number within the current date.
 */
export function generateHistoryId(fs: FileAccessLayer): string {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')

  const history = readRecipeHistory(fs)
  const todayPrefix = `r_${dateStr}_`
  const todayEntries = history.filter((e) => e.id.startsWith(todayPrefix))
  const nextNum = todayEntries.length + 1

  return `${todayPrefix}${String(nextNum).padStart(3, '0')}`
}
