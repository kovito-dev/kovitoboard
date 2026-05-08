/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe history — read/write .kovitoboard/recipe-history.jsonl
 */
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

  let content: string
  try {
    content = fs.readFileSync(path, 'utf-8')
  } catch (err) {
    console.error('[recipe-history] Failed to read history:', err)
    return []
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const entries: RecipeHistoryEntry[] = []
  let parseFailures = 0
  let warnedCount = 0
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as RecipeHistoryEntry)
    } catch (err) {
      parseFailures += 1
      if (warnedCount < MAX_PARSE_WARNINGS) {
        console.warn(
          '[recipe-history] Skipping unparseable line:',
          err instanceof Error ? err.message : String(err),
        )
        warnedCount += 1
      }
    }
  }
  if (parseFailures > MAX_PARSE_WARNINGS) {
    console.warn(
      `[recipe-history] Suppressed ${parseFailures - MAX_PARSE_WARNINGS} additional parse warnings (corruption suspected).`,
    )
  }

  // Whole-file corruption: at least half of the non-empty lines failed
  // to parse. Rotate out of the way so we do not re-warn on every
  // subsequent read; the next append will start a fresh file. The
  // entries we *did* manage to parse are intentionally returned —
  // dropping them would lose recoverable history for marginal benefit.
  const failureRatio = lines.length > 0 ? parseFailures / lines.length : 0
  if (lines.length > 0 && failureRatio >= CORRUPTION_ROTATE_THRESHOLD) {
    const corruptedPath = `${path}.corrupted`
    try {
      fs.renameSync(path, corruptedPath)
      console.error(
        `[recipe-history] Corruption ratio ${(failureRatio * 100).toFixed(0)}% (${parseFailures}/${lines.length}); rotated to ${corruptedPath}.`,
      )
    } catch (err) {
      console.error(
        '[recipe-history] Failed to rename corrupted history file:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return entries
}

/**
 * Append a single history entry to the JSONL file.
 *
 * Implementation note: this used to read the entire file, concatenate
 * the new line, and `writeFileSync` it back — a read-modify-write cycle
 * that lost entries when two callers raced (Codex review #17) and that
 * could leave a half-written file behind on a crash (review S10). The
 * current implementation uses `appendFileSync`, which on POSIX is a
 * single `write(2)` for short payloads and therefore atomic with
 * respect to other appends to the same file.
 */
export function appendRecipeHistory(fs: FileAccessLayer, entry: RecipeHistoryEntry): void {
  const path = getRecipeHistoryPath(fs)
  const dir = getKovitoboardDir(fs)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const line = JSON.stringify(entry) + '\n'
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
