/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * CLAUDE.md guidance-block injection.
 *
 * Spec SSOT: `docs/specs/claude-md-guidance-injection.md` v1.2 (in
 * the kovitoboard-dev workspace).
 *
 * KovitoBoard injects a minimal guidance block into
 * `<projectRoot>/CLAUDE.md` exactly once when onboarding completes
 * (state transition `onboarding.completedAt: null → string`). The
 * block is wrapped between `<!-- KB:GUIDANCE_START -->` and
 * `<!-- KB:GUIDANCE_END -->` markers and points all agents at
 * `kovitoboard/docs/agent-ref/INDEX.md`.
 *
 * Injection policy (spec §5.2):
 *   - File missing                  → create new file with marker block
 *                                     only.
 *   - File exists, no markers       → append marker block to the end
 *                                     (preserving original content and
 *                                     line endings).
 *   - File exists, well-formed pair → no-op (already injected; never
 *                                     re-inject — see §5.5).
 *   - File exists, broken markers   → no-op (refuse to repair; see
 *                                     §8.2).
 *   - `setting.claudeMdGuidance.disabled === true` → skip entirely.
 *
 * Caller contract: `maybeInjectClaudeMdGuidance` is invoked from the
 * `PUT /api/config/setting` route handler when the wizard transitions
 * `onboarding.completedAt` from null to a string. The injection is
 * best-effort — failures (write errors, broken markers, missing
 * project path) are reported back via the `reason` field but never
 * bubble as exceptions, so onboarding completion is not blocked.
 *
 * Atomic write semantics come from `fs.writeFileAtomic` (DirectFsLayer
 * backs it with same-directory `rename(2)` plus optional `fsync`),
 * matching `data-persistence.md` v1.1 §7.2 SSOT. CLAUDE.md is the
 * user's file — `writeFileAtomic` preserves the existing mode bits
 * verbatim on rewrite, so a chmodded-by-the-operator file keeps its
 * permissions.
 */

import { join } from 'path'
import type { FileAccessLayer, FileLstat } from '../fs-layer'
import type { KovitoboardSetting } from '../../shared/setting-types'
import { lazyChildLogger } from '../logger'

const log = lazyChildLogger('claude-md-guidance')

/**
 * Body of the guidance block (spec §6.1, exact wording — about 200
 * characters total). Stored as an array of physical lines so the
 * caller can join with the destination file's existing EOL when
 * appending to a CRLF file.
 *
 * Do NOT edit this content without bumping the spec — it is the
 * canonical guidance text injected into every user's CLAUDE.md.
 */
const GUIDANCE_LINES: readonly string[] = [
  '<!-- KB:GUIDANCE_START -->',
  'This project uses KovitoBoard (KB) at `./kovitoboard/`. For any',
  'KovitoBoard-related task, start with',
  '`kovitoboard/docs/agent-ref/INDEX.md`.',
  '<!-- KB:GUIDANCE_END -->',
] as const

/**
 * Marker detection (spec §8.1). A well-formed pair satisfies this
 * regex AND occurs exactly once in the file. We split this into three
 * separate regexes — one for the well-formed pair, two for counting
 * each side independently — so we can distinguish "already injected"
 * from "broken markers" (start-only, end-only, multiple pairs).
 */
const PAIR_REGEX =
  /<!--\s*KB:GUIDANCE_START\s*-->[\s\S]*?<!--\s*KB:GUIDANCE_END\s*-->/
const START_REGEX = /<!--\s*KB:GUIDANCE_START\s*-->/g
const END_REGEX = /<!--\s*KB:GUIDANCE_END\s*-->/g

/**
 * Result of an injection attempt.
 *
 * - `injected`: true iff the block was actually written (created or
 *   appended). Callers use this to decide whether to record
 *   `lastInjectedAt` in `setting.json`.
 * - `injectedAt`: ISO 8601 UTC timestamp when `injected === true`,
 *   undefined otherwise. Captured at the moment of write so the
 *   record matches the file's mtime closely.
 * - `reason`: a short tag explaining the outcome. Useful for
 *   structured logging and for tests to assert which branch ran.
 */
export interface ClaudeMdInjectionResult {
  injected: boolean
  injectedAt?: string
  reason:
    | 'created'
    | 'appended'
    | 'already-injected'
    | 'broken-markers'
    | 'disabled'
    | 'no-project-path'
    | 'read-failed'
    | 'write-failed'
    | 'file-too-large'
    | 'special-file'
}

/**
 * Defensive cap on the existing CLAUDE.md size before we load it
 * into memory and scan for markers. The file lives under the
 * user-controlled project root, so an unusually large value is
 * either accidental (committed binary, runaway log appended into the
 * file) or adversarial. A normal CLAUDE.md is at most a few KB; 1 MB
 * is a generous ceiling that still keeps the synchronous read off
 * the event-loop hazard list.
 *
 * Above the cap we skip injection entirely (`reason:
 * 'file-too-large'`) instead of refusing the entire onboarding
 * write — the helper's contract is best-effort.
 *
 * Note: the spec (`claude-md-guidance-injection.md` v1.2 §5) does
 * not yet list this branch. A backlog item tracks the spec follow-up
 * (BL-2026-XXX in kovitoboard-dev/tasks/backlog.md).
 */
const MAX_CLAUDE_MD_BYTES = 1 * 1024 * 1024

/**
 * Detect the file's line ending. CRLF wins iff the file contains at
 * least one `\r\n` pair — otherwise LF (or empty file) is assumed.
 *
 * We preserve the existing EOL when appending so a Windows-line-ending
 * CLAUDE.md stays Windows-line-ending after the block is added; mixed
 * EOLs in the file would be rare but the dominant style is what we
 * pick for the new content.
 */
function detectEol(raw: string): '\n' | '\r\n' {
  return raw.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Check the wizard opt-out flag and resolve the destination path. Pure
 * helper extracted so the route handler (and tests) can call the
 * trigger condition without re-implementing the policy.
 *
 * The CLAUDE.md path is anchored on the *server-trusted* `projectRoot`
 * the supervisor resolved at startup, NOT on `setting.project.path`
 * from the request body. Trusting the client payload here would let a
 * crafted PUT redirect the write outside the intended project root
 * (any caller of `PUT /api/config/setting` can put any string in
 * `project.path` — `validateSetting` only checks the type and
 * non-emptiness, not the location).
 *
 * Returns either the absolute CLAUDE.md path to inject into, or a
 * `reason` tag explaining why injection is not attempted (so the
 * caller can log a single structured event).
 */
function resolveTarget(
  setting: KovitoboardSetting,
  projectRoot: string,
):
  | { path: string }
  | { skip: 'disabled' | 'no-project-path' } {
  if (setting.claudeMdGuidance?.disabled === true) {
    return { skip: 'disabled' }
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    // The supervisor always resolves a non-empty projectRoot at
    // startup; an empty value here means the route was wired up
    // wrong. Skip injection rather than fall back to anything that
    // could be influenced by the request body.
    return { skip: 'no-project-path' }
  }
  return { path: join(projectRoot, 'CLAUDE.md') }
}

/**
 * Inject the guidance block into `<projectRoot>/CLAUDE.md` according
 * to the policy in spec §5.2. Returns a structured result; never
 * throws.
 *
 * Branch summary:
 *
 * - File missing → create new file containing only the marker block
 *   (no header / preface — see spec §5.4 v1.1 minimization).
 * - File exists, no markers → append `EOL + EOL + block + EOL` to the
 *   trimmed body, preserving the original line ending.
 * - File exists, exactly one well-formed pair → no-op
 *   ('already-injected'), regardless of whether the body inside the
 *   markers matches the canonical text. Updating in-place is out of
 *   scope for v1.0 (see spec §10.3).
 * - File exists, partial markers (start-only / end-only / multiple
 *   pairs) → no-op ('broken-markers'). Refuse to "repair" the file —
 *   the user may have intentionally edited it. Logged at WARN so
 *   operators can investigate.
 *
 * This helper is **not** exported as a stable surface; the route
 * layer should call `maybeInjectClaudeMdGuidance` instead, which also
 * checks the opt-out flag.
 */
function injectIntoFile(
  fs: FileAccessLayer,
  claudeMdPath: string,
): ClaudeMdInjectionResult {
  // SECURITY: lstat (NOT stat) the path before any read or write.
  //
  // The path resolves to `<projectRoot>/CLAUDE.md` under the
  // user-controlled project root. A repository can plant a symlink at
  // that location that points outside the project root, or a FIFO /
  // device file that would block the synchronous read on the
  // onboarding request handler. Without an lstat-based gate the
  // upstream `existsSync` / `readFileSync` chain would silently follow
  // the symlink (yielding the link target's contents and an unintended
  // write target via `writeFileAtomic`), and the FIFO case would hang
  // the request indefinitely. lstat returns metadata about the link
  // itself, so a symlink reports `isSymbolicLink: true` even when its
  // target exists.
  //
  // ENOENT is the normal "file does not exist" path and falls through
  // to the new-file branch. Any other error (EACCES, etc.) is a hard
  // skip — we cannot make a safe call without seeing the metadata.
  let lstat: FileLstat | null = null
  try {
    lstat = fs.lstatSync(claudeMdPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn(
        { err, path: claudeMdPath },
        '[claude-md-guidance] Failed to lstat CLAUDE.md target',
      )
      return { injected: false, reason: 'read-failed' }
    }
  }

  if (lstat && (lstat.isSymbolicLink || !lstat.isFile)) {
    log.warn(
      {
        path: claudeMdPath,
        isSymbolicLink: lstat.isSymbolicLink,
        isFile: lstat.isFile,
      },
      '[claude-md-guidance] CLAUDE.md target is a symlink or non-regular file; refusing to read or write',
    )
    return { injected: false, reason: 'special-file' }
  }

  const exists = lstat !== null

  if (!exists) {
    // New file: write just the marker block + a trailing newline so
    // the file ends with the standard POSIX text-file convention.
    // Default EOL is LF (the file did not exist, so there is no prior
    // convention to honor).
    const content = GUIDANCE_LINES.join('\n') + '\n'
    try {
      fs.writeFileAtomic(claudeMdPath, content)
    } catch (err) {
      log.warn(
        { err, path: claudeMdPath },
        '[claude-md-guidance] Failed to create CLAUDE.md',
      )
      return { injected: false, reason: 'write-failed' }
    }
    log.info(
      { path: claudeMdPath },
      '[claude-md-guidance] Created CLAUDE.md with guidance block',
    )
    return {
      injected: true,
      injectedAt: new Date().toISOString(),
      reason: 'created',
    }
  }

  // Defensive: stat the file before loading the entire body into
  // memory. The path lives under the user-controlled project root
  // and the route handler runs synchronously, so an unusually large
  // CLAUDE.md (committed binary, runaway log appended into it,
  // adversarial input) could otherwise block the event loop while
  // we scan for markers. Above MAX_CLAUDE_MD_BYTES we skip
  // injection rather than degrade the onboarding response.
  try {
    const stat = fs.statSync(claudeMdPath)
    if (stat.size > MAX_CLAUDE_MD_BYTES) {
      log.warn(
        { path: claudeMdPath, size: stat.size, cap: MAX_CLAUDE_MD_BYTES },
        '[claude-md-guidance] CLAUDE.md exceeds defensive size cap; skipping injection',
      )
      return { injected: false, reason: 'file-too-large' }
    }
  } catch (err) {
    log.warn(
      { err, path: claudeMdPath },
      '[claude-md-guidance] Failed to stat existing CLAUDE.md',
    )
    return { injected: false, reason: 'read-failed' }
  }

  let raw: string
  try {
    raw = fs.readFileSync(claudeMdPath, 'utf-8')
  } catch (err) {
    log.warn(
      { err, path: claudeMdPath },
      '[claude-md-guidance] Failed to read existing CLAUDE.md',
    )
    return { injected: false, reason: 'read-failed' }
  }

  // Marker detection: count START / END occurrences independently so
  // we can distinguish well-formed (1+1) from partial / multi-pair
  // edge cases.
  const startCount = (raw.match(START_REGEX) ?? []).length
  const endCount = (raw.match(END_REGEX) ?? []).length

  if (startCount === 0 && endCount === 0) {
    // No markers — append. Preserve the original EOL so a CRLF file
    // stays CRLF after the append.
    const eol = detectEol(raw)
    const trimmed = raw.replace(/(\r?\n)+$/, '')
    const block = GUIDANCE_LINES.join(eol)
    // Empty existing file (whitespace-only or zero-byte): emit just
    // the block + trailing EOL so the on-disk result matches the
    // fresh-create branch (spec §5.4 minimal-content goal). Otherwise
    // `${trimmed}${eol}${eol}${block}${eol}` puts a single blank line
    // between the existing content and the marker block, then ends
    // with a final newline (POSIX text-file convention).
    const newContent =
      trimmed === '' ? `${block}${eol}` : `${trimmed}${eol}${eol}${block}${eol}`
    try {
      fs.writeFileAtomic(claudeMdPath, newContent)
    } catch (err) {
      log.warn(
        { err, path: claudeMdPath },
        '[claude-md-guidance] Failed to append guidance block',
      )
      return { injected: false, reason: 'write-failed' }
    }
    log.info(
      { path: claudeMdPath },
      '[claude-md-guidance] Appended guidance block to existing CLAUDE.md',
    )
    return {
      injected: true,
      injectedAt: new Date().toISOString(),
      reason: 'appended',
    }
  }

  if (startCount === 1 && endCount === 1 && PAIR_REGEX.test(raw)) {
    // Already injected. Spec §5.5 (re-injection-never policy) — even
    // if the body inside the markers diverges from the canonical
    // text, leave it alone.
    return { injected: false, reason: 'already-injected' }
  }

  // Anything else is a broken marker layout (start-only, end-only,
  // multiple pairs, or a pair where START occurs after END). Refuse
  // to "repair" the file — the user may have intentionally edited
  // it. spec §8.2.
  log.warn(
    { path: claudeMdPath, startCount, endCount },
    '[claude-md-guidance] Broken KB:GUIDANCE markers; skipping injection',
  )
  return { injected: false, reason: 'broken-markers' }
}

/**
 * Public entry point for the `PUT /api/config/setting` handler.
 *
 * Trigger condition (spec §8.3): the caller must have already
 * verified that this request transitions `onboarding.completedAt`
 * from null/undefined to a string value. This helper does NOT detect
 * the transition itself — it just executes the injection policy
 * once invoked.
 *
 * `projectRoot` is the supervisor-resolved, server-trusted absolute
 * path the route layer has on hand from `createConfigRouter(fs,
 * projectRoot)`. The helper deliberately does not look at
 * `setting.project.path`, so a crafted PUT body cannot redirect the
 * write outside the trusted project root.
 *
 * Best-effort semantics: any failure is logged and reported via the
 * `reason` tag, never thrown. The caller must continue with
 * `writeSetting` regardless.
 */
export function maybeInjectClaudeMdGuidance(
  fs: FileAccessLayer,
  setting: KovitoboardSetting,
  projectRoot: string,
): ClaudeMdInjectionResult {
  const target = resolveTarget(setting, projectRoot)
  if ('skip' in target) {
    return { injected: false, reason: target.skip }
  }
  return injectIntoFile(fs, target.path)
}

/**
 * Re-exported test helper. Only the spec test suite should reach
 * past `maybeInjectClaudeMdGuidance`; production callers always go
 * through the public entry point so the opt-out flag is honored.
 */
export const __testing__ = {
  injectIntoFile,
  detectEol,
  GUIDANCE_LINES,
  PAIR_REGEX,
  START_REGEX,
  END_REGEX,
}
