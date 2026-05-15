/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * cwd allow-list validator (spec `cwd-allowlist.md` v1.0 §6.3 SSOT).
 *
 * `validateCwd()` is a pure function: same arguments produce the same
 * result (modulo the supplied `FileAccessLayer` I/O). Lazy probe /
 * metadata persist is the caller's responsibility (§7.6 SSOT); when
 * `workRootsMetadata` is missing the entry for the root that contains
 * the cwd, the validator returns `{ ok: false, reason: 'probe_failed' }`
 * without touching disk (§6.3 path b — defensive fallback).
 *
 * The validator deliberately avoids depending on `process.cwd()` /
 * `process.env` / `os.homedir()` directly: those are consulted only
 * via the `getDenylistAnchors()` helper, which is itself exported for
 * test substitution. This keeps the security boundary auditable —
 * exactly one entry point reads the environment, and tests can
 * replace it to drive every code path deterministically.
 *
 * Spec touch-points:
 *   - §6.3 ValidateCwdResult union shape, including the optional
 *     `matchedRoot` / `matchedRootKind` / `addToAllowListPossible` fields.
 *   - §7.1 caller-side gate flow (validation run after caller precheck).
 *   - §7.3 denylist anchors (`/`, system dirs, `~`, KB repo root).
 *   - §7.6 per-root case-sensitivity comparison.
 *   - §8.3 post-validation TOCTOU defence — callers MUST pass
 *     `resolvedCwd` (the realpath form) to `spawn()` / tmux, not the
 *     original `requestedCwd`.
 */

import { homedir } from 'os'
import { realpathSync } from 'fs'
import { isAbsolute, relative } from 'path'
import type { FileAccessLayer } from './fs-layer'
import type { WorkRootMetadata } from '../shared/setting-types'

// --- public types -------------------------------------------------------

/** Discriminator for which kind of allow-list entry matched the cwd. */
export type RootKind = 'project_root' | 'additional_work_root'

/** Failure reasons for `validateCwd`. See §6.4 for the HTTP envelope mapping. */
export type ValidateCwdReason =
  | 'not_allowed'
  | 'not_absolute'
  | 'not_found'
  | 'not_directory'
  | 'symlink_loop'
  | 'permission_denied'
  | 'probe_failed'

/**
 * Outcome of `validateCwd`. The `ok: true` branch carries the canonical
 * `resolvedCwd` that callers MUST pass downstream to `spawn()` / tmux
 * instead of the original `requestedCwd` (§8.3 TOCTOU defence).
 *
 * On the `ok: false` branch:
 *   - `matchedRoot` / `matchedRootKind` are populated for
 *     `probe_failed` (the root whose metadata was missing) and MAY be
 *     populated for `not_allowed` (the nearest candidate root, for
 *     diagnostics). Other reasons omit them.
 *   - `addToAllowListPossible` is set for `not_allowed` only. `false`
 *     means the UI should suppress the "add as work root" CTA because
 *     the candidate path is denylisted (§7.3).
 */
export type ValidateCwdResult =
  | {
      ok: true
      resolvedCwd: string
      matchedRoot: string
      matchedRootKind: RootKind
    }
  | {
      ok: false
      reason: ValidateCwdReason
      matchedRoot?: string
      matchedRootKind?: RootKind
      addToAllowListPossible?: boolean
    }

// --- canonical normalisation -------------------------------------------

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/

/**
 * Normalise a path to its canonical comparison form, governed by the
 * per-root case-sensitivity captured at probe time (§7.6 SSOT).
 *
 *   - Applies Unicode NFC normalisation so canonically equivalent
 *     spellings (e.g. macOS HFS+ NFD vs APFS NFC, or hand-edited
 *     entries) compare equal (CodeX PR #38 Attempt 11 LOW 2).
 *     `realpath` on Linux + APFS already returns NFC, but legacy
 *     HFS+ targets / hand-edited `setting.json` entries can hold
 *     NFD; folding them at the comparison layer fixes the mismatch.
 *   - Unifies `\\` -> `/` so Windows paths compare against allow-list
 *     entries that were captured via `realpath`.
 *   - Lowercases the drive letter on Windows (`C:/` -> `c:/`).
 *   - Strips trailing `/` so `/foo/` and `/foo` compare equal (but
 *     `/` itself is preserved).
 *   - Lowercases the entire path on case-insensitive FS so `/Proj`
 *     matches `/proj`.
 */
export function normaliseCanonical(input: string, caseSensitive: boolean): string {
  let p = input.normalize('NFC').replace(/\\/g, '/')
  if (WINDOWS_DRIVE_RE.test(p)) {
    p = p[0].toLowerCase() + p.slice(1)
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (!caseSensitive) p = p.toLowerCase()
  return p
}

/**
 * Path-component-boundary-safe subtree check.
 *
 * `/project-evil` must NOT match `/project`. Using
 * `path.relative` lets Node handle separator differences across OSes
 * (§7.6 SSOT). On case-insensitive FS the caller-supplied
 * `caseSensitive: false` lowercases both sides before relative-ising.
 */
export function isSubtree(
  parent: string,
  candidate: string,
  caseSensitive: boolean,
): boolean {
  const p = normaliseCanonical(parent, caseSensitive)
  const c = normaliseCanonical(candidate, caseSensitive)
  if (p === c) return true
  const rel = relative(p, c)
  if (rel.length === 0) return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

// --- denylist ----------------------------------------------------------

/**
 * POSIX system directories that may never be added as work roots
 * (§7.3). Stored lowercased so we can compare against the
 * case-folded form regardless of FS case-sensitivity.
 */
const POSIX_DENY_DIRS = new Set<string>([
  '/',
  '/etc',
  '/usr',
  '/var',
  '/opt',
  '/srv',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/system',
  '/library',
  '/applications',
])

/** Windows system directories that may never be added as work roots. */
const WINDOWS_DENY_DIRS = new Set<string>([
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
])

/**
 * Return true when `canonicalPath` matches any §7.3 denylist anchor.
 *
 * Subtree entries (e.g. `~/Documents/foo` under `~`) are allowed; only
 * the listed paths themselves are blocked. `homedir` and `kbRepoRoot`
 * are caller-supplied so tests can drive the function without touching
 * the real environment.
 *
 * The comparison is case-insensitive — the worst case (a
 * case-insensitive FS thinking `/ETC` and `/etc` are the same) must
 * still block.
 */
export function isDenylisted(
  canonicalPath: string,
  homedir: string,
  kbRepoRoot: string,
): boolean {
  const normalised = normaliseCanonical(canonicalPath, false)
  if (POSIX_DENY_DIRS.has(normalised)) return true
  if (WINDOWS_DENY_DIRS.has(normalised)) return true
  if (normalised === normaliseCanonical(homedir, false)) return true
  if (normalised === normaliseCanonical(kbRepoRoot, false)) return true
  return false
}

/**
 * Resolve the environment-derived denylist anchors (§7.3).
 *
 * Exported as a discrete helper so `validateCwd` keeps its
 * pure-by-arguments shape and tests can substitute the anchors via
 * the optional `anchors` parameter on `validateCwd`. The default
 * production behaviour reads:
 *   - `os.homedir()` for the user's home directory anchor.
 *   - `process.env.KOVITOBOARD_PROJECT_ROOT ?? process.cwd()` for the
 *     KB repo root anchor (matches `config.ts` resolution order).
 *
 * Both anchors are canonicalised via `realpathSync` before being
 * returned, so a caller who supplies a symlink, bind mount, or
 * junction form of the home / repo root still matches the denylist
 * after `validateCwd` canonicalises the request cwd (CodeX PR #38
 * Attempt 5 HIGH 1). If `realpathSync` fails for either anchor
 * (extremely rare — typically only when the underlying directory is
 * gone) we fall back to the raw value so the denylist still blocks
 * the literal path; the symlink-bypass surface is then unprotected,
 * but that already requires the user's home / repo root to be in a
 * malformed state.
 */
export function getDenylistAnchors(): { homedir: string; kbRepoRoot: string } {
  const rawHome = homedir()
  const rawRepo = process.env.KOVITOBOARD_PROJECT_ROOT ?? process.cwd()
  return {
    homedir: tryRealpath(rawHome),
    kbRepoRoot: tryRealpath(rawRepo),
  }
}

/**
 * Best-effort `realpathSync` wrapper. Returns the raw input when
 * resolution fails so the denylist still blocks the literal form.
 * Used only by `getDenylistAnchors` — the main `validateCwd` path
 * stays free of raw `fs` calls and routes every resolution through
 * the injected `FileAccessLayer`.
 */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// --- main validator ----------------------------------------------------

/**
 * Optional test seam: pass explicit denylist anchors instead of reading
 * the environment. Production callers omit this and let `validateCwd`
 * call `getDenylistAnchors()` itself.
 */
export interface ValidateCwdOptions {
  denylistAnchors?: { homedir: string; kbRepoRoot: string }
}

/**
 * Validate a request cwd against the allow-list (§6.3 / §7.1 SSOT).
 *
 * Algorithm:
 *   0. Reject non-absolute paths with `not_absolute` before any
 *      filesystem call. Without this guard, relative inputs like `.`
 *      or `subdir` would be resolved against the Node process cwd
 *      inside `realpathSync()`, making the allow-list boundary
 *      depend on server startup state (CodeX PR #38 Attempt 7 MED 1).
 *   1. Resolve via `realpathSync` to the canonical form. ENOENT /
 *      ELOOP / EACCES map to dedicated reasons (`not_found` /
 *      `symlink_loop` / `permission_denied`). We deliberately skip an
 *      `existsSync()` precheck because it would flatten EACCES / ELOOP
 *      into `not_found` (CodeX Attempt 2 LOW 3).
 *   2. Reject when the canonical form is not a directory
 *      (`not_directory`).
 *   3. Resolve every allowed root to its own canonical form (skipping
 *      stale entries that fail realpath).
 *   4. For each root, look up its `workRootsMetadata[<canonicalRoot>]`
 *      entry. Missing metadata for a containing root surfaces
 *      `probe_failed` per §6.3 path b.
 *   5. If no root contains the cwd, return `not_allowed` plus
 *      `addToAllowListPossible` (false when the path itself is
 *      denylisted, true otherwise).
 *
 * Pure function: I/O happens only through the supplied
 * `FileAccessLayer`. `addToAllowListPossible` consults the environment
 * via `getDenylistAnchors()` unless overridden by `options`.
 */
export function validateCwd(
  requestedCwd: string,
  projectRoot: string,
  additionalWorkRoots: string[],
  workRootsMetadata: Record<string, WorkRootMetadata>,
  fs: FileAccessLayer,
  options?: ValidateCwdOptions,
): ValidateCwdResult {
  // 0. Absolute-only precondition. `realpathSync()` resolves
  //    relative inputs against `process.cwd()`, which would make
  //    the allow-list boundary depend on server startup state and
  //    silently accept inputs like `.` or `subdir`. Reject before
  //    touching the filesystem (CodeX PR #38 Attempt 7 MED 1).
  if (!isAbsolute(requestedCwd)) {
    return { ok: false, reason: 'not_absolute' }
  }

  // 1. realpath, errno-aware. We no longer pre-check with
  //    `fs.existsSync()`: it returns `false` for both ENOENT and
  //    paths that fail with EACCES / ELOOP, which would flatten the
  //    distinct `permission_denied` / `symlink_loop` reasons defined
  //    by §6.4 into `not_found`. `realpathSync()` surfaces the right
  //    errno directly (CodeX Attempt 2 LOW 3). Dangling-symlink
  //    chains still return ENOENT here, so the documented "chain
  //    exists but target is gone → not_found" behaviour is preserved.
  let canonical: string
  try {
    canonical = fs.realpathSync(requestedCwd)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: 'not_found' }
    if (code === 'ELOOP') return { ok: false, reason: 'symlink_loop' }
    if (code === 'EACCES') return { ok: false, reason: 'permission_denied' }
    // Unknown errno from realpath: fail-closed via not_found so we
    // never claim the cwd is allowed.
    return { ok: false, reason: 'not_found' }
  }

  // 2. isDirectory check on the realpath'd form.
  let stat
  try {
    stat = fs.statSync(canonical)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: 'not_found' }
    if (code === 'EACCES') return { ok: false, reason: 'permission_denied' }
    return { ok: false, reason: 'not_found' }
  }
  if (!stat.isDirectory) {
    return { ok: false, reason: 'not_directory' }
  }

  // 4. Resolve allowed roots. realpath failures here mean the root no
  //    longer exists / is unreachable — skip silently; the orphan
  //    cleanup belongs to the caller-side bootstrap / setting reader.
  type RootCandidate = { kind: RootKind; canonicalRoot: string }
  const rootCandidates: RootCandidate[] = []
  const seen = new Set<string>()
  const addRoot = (root: string, kind: RootKind): void => {
    let resolved: string
    try {
      resolved = fs.realpathSync(root)
    } catch {
      return
    }
    if (seen.has(resolved)) return
    seen.add(resolved)
    rootCandidates.push({ kind, canonicalRoot: resolved })
  }
  addRoot(projectRoot, 'project_root')
  for (const r of additionalWorkRoots) {
    addRoot(r, 'additional_work_root')
  }

  // 5. Subtree match. Metadata-missing for a containing root surfaces
  //    probe_failed (§6.3 path b). The case-sensitive fallback below
  //    is intentional: it lets us recognise "the cwd unambiguously
  //    sits inside this root" without committing to a case rule that
  //    we cannot yet determine.
  for (const c of rootCandidates) {
    const meta = workRootsMetadata[c.canonicalRoot]
    if (!meta) {
      if (isSubtree(c.canonicalRoot, canonical, true)) {
        return {
          ok: false,
          reason: 'probe_failed',
          matchedRoot: c.canonicalRoot,
          matchedRootKind: c.kind,
        }
      }
      continue
    }
    if (isSubtree(c.canonicalRoot, canonical, meta.caseSensitive)) {
      return {
        ok: true,
        resolvedCwd: canonical,
        matchedRoot: c.canonicalRoot,
        matchedRootKind: c.kind,
      }
    }
  }

  // 6. not_allowed: derive `addToAllowListPossible` from the denylist
  //    so the UI can hide the "add to allow-list" CTA for system /
  //    KB-self paths (§7.3 / §10.2).
  const anchors = options?.denylistAnchors ?? getDenylistAnchors()
  const addable = !isDenylisted(canonical, anchors.homedir, anchors.kbRepoRoot)
  return {
    ok: false,
    reason: 'not_allowed',
    addToAllowListPossible: addable,
  }
}
