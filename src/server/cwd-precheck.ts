/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Caller-side helpers for the cwd allow-list gate
 * (spec `cwd-allowlist.md` v1.0 §7.1 / §7.6 SSOT).
 *
 * `validateCwd()` is a pure function and does not touch disk for
 * metadata bookkeeping. The five cwd consumers (claude-bridge,
 * /api/sessions/new, /api/tmux/start-agent, session-resume, and the
 * two tmux-bridge helpers) all need to:
 *   1. Make sure `workRootsMetadata` covers every root they will
 *      compare against — running a probe + write-back when missing
 *      (§7.6 lifecycle).
 *   2. Translate `ValidateCwdResult` into the §6.4 HTTP / log
 *      envelope before responding.
 *
 * Both are non-trivial enough that copy-paste across five sites
 * would drift; this module is the SSOT.
 *
 * The probe runs through `proper-lockfile`-backed `writeSettingCas`,
 * so concurrent consumers cannot stomp each other's metadata writes.
 * Probe write-back failures are non-fatal: the in-memory state is
 * still returned so the validator can run, and the next caller
 * retries the probe.
 */

import type { FileAccessLayer } from './fs-layer'
import type {
  KovitoboardSetting,
  WorkRootMetadata,
} from '../shared/setting-types'
import { lazyChildLogger } from './logger'
import {
  readSettingWithRevision,
  writeSettingCas,
  SettingConflictError,
} from './setting-manager'
import { probeWorkRoot } from './fs-probe'
import type { RootKind, ValidateCwdResult } from './cwdValidator'

const precheckLog = lazyChildLogger('cwd-precheck')

/**
 * Snapshot of the allow-list state used by `validateCwd()`.
 *
 *   - `additionalWorkRoots`: raw paths from setting.json (passed
 *     verbatim to validateCwd; the validator realpath's them itself
 *     so the snapshot remains comparable across processes).
 *   - `workRootsMetadata`: keyed by **canonical** path (post-realpath),
 *     which is also what `probeWorkRoot()` writes to disk.
 */
export interface CwdAllowListSnapshot {
  additionalWorkRoots: string[]
  workRootsMetadata: Record<string, WorkRootMetadata>
}

/**
 * Ensure `workRootsMetadata` covers `projectRoot` and every entry in
 * `additionalWorkRoots`. Missing entries trigger a synchronous probe
 * (`probeWorkRoot()`) and an in-process CAS write-back.
 *
 * Return value is the post-probe snapshot that the caller passes to
 * `validateCwd()`. When the setting file is absent (fresh install
 * before onboarding) the snapshot is empty and `validateCwd()` will
 * correctly reject any cwd that does not resolve to `projectRoot`'s
 * subtree — even without setting.json, `projectRoot` itself is
 * realpath-resolved inside `validateCwd()`, but without metadata the
 * check returns `probe_failed`, which is the right fail-closed
 * outcome here.
 */
export function ensureWorkRootMetadata(
  fs: FileAccessLayer,
  projectRoot: string,
): CwdAllowListSnapshot {
  const current = readSettingWithRevision(fs)
  if (!current) {
    // Pre-onboarding: no setting file. Caller still gets an empty
    // snapshot — validateCwd() will report not_allowed /
    // probe_failed which the consumer translates per §7.1.
    return { additionalWorkRoots: [], workRootsMetadata: {} }
  }

  const setting = current.setting
  const additionalWorkRoots = setting.additionalWorkRoots ?? []
  const currentMeta = setting.workRootsMetadata ?? {}

  // Probe any root (projectRoot + additionalWorkRoots) whose
  // canonical form has no metadata yet. We realpath each root
  // up-front so the metadata key matches what validateCwd() will
  // look up later.
  const candidates: string[] = []
  pushIfCanResolve(candidates, projectRoot, fs)
  for (const r of additionalWorkRoots) pushIfCanResolve(candidates, r, fs)

  const nextMeta: Record<string, WorkRootMetadata> = { ...currentMeta }
  let changed = false
  for (const canonical of candidates) {
    if (nextMeta[canonical]) continue
    const probed = probeWorkRoot(canonical, fs)
    if (probed) {
      nextMeta[canonical] = probed
      changed = true
    }
    // probe failure: leave metadata absent; validateCwd() will
    // surface probe_failed (§6.3 path b).
  }

  if (changed) {
    persistMetadataBestEffort(fs, setting, current.revision, nextMeta)
  }

  return { additionalWorkRoots, workRootsMetadata: nextMeta }
}

/**
 * HTTP / UI error body for §6.4 (the consumer-cwd-validation envelope).
 *
 * Differs from `/api/work-roots`'s endpoint-local envelope (§6.2.2):
 * this one carries `requested_cwd` + `allowed_roots` so the UI can
 * show "we expected the cwd to be under …" guidance, and the
 * `matchedRoot` / `matchedRootKind` / `addToAllowListPossible`
 * fields drive the resume-rejection UI (§10.2).
 */
export interface CwdErrorBody {
  error: string
  message: string
  requested_cwd: string
  allowed_roots?: string[]
  matchedRoot?: string
  matchedRootKind?: RootKind
  addToAllowListPossible?: boolean
}

/**
 * Map a `ValidateCwdResult` failure to the §6.4 HTTP body plus an
 * HTTP status. Callers spread the body into `res.json(...)` and use
 * the status verbatim.
 *
 * `not_found` / `not_directory` / `symlink_loop` /
 * `permission_denied` / `not_allowed` / `probe_failed` all return
 * HTTP 400 per §6.4 — `spawn_failed` (post-validation) is HTTP 500
 * but that lives outside this module (§8.4).
 */
export function buildCwdErrorResponse(
  result: Extract<ValidateCwdResult, { ok: false }>,
  requestedCwd: string,
  projectRoot: string,
  additionalWorkRoots: string[],
): { status: number; body: CwdErrorBody } {
  const body: CwdErrorBody = {
    error: REASON_TO_HTTP_ERROR[result.reason],
    message: REASON_TO_MESSAGE[result.reason],
    requested_cwd: requestedCwd,
  }
  if (result.reason === 'not_allowed') {
    body.allowed_roots = [projectRoot, ...additionalWorkRoots]
    if (typeof result.addToAllowListPossible === 'boolean') {
      body.addToAllowListPossible = result.addToAllowListPossible
    }
  }
  if (result.reason === 'probe_failed') {
    if (result.matchedRoot) body.matchedRoot = result.matchedRoot
    if (result.matchedRootKind) body.matchedRootKind = result.matchedRootKind
  }
  return { status: 400, body }
}

// --- error code / message tables (§6.4 mapping) ------------------------

const REASON_TO_HTTP_ERROR: Record<
  Extract<ValidateCwdResult, { ok: false }>['reason'],
  string
> = {
  not_found: 'cwd_not_found',
  not_directory: 'cwd_not_directory',
  symlink_loop: 'cwd_symlink_loop',
  permission_denied: 'cwd_permission_denied',
  not_allowed: 'cwd_not_allowed',
  probe_failed: 'cwd_probe_failed',
}

const REASON_TO_MESSAGE: Record<
  Extract<ValidateCwdResult, { ok: false }>['reason'],
  string
> = {
  not_found: 'The requested cwd does not exist.',
  not_directory: 'The requested cwd is not a directory.',
  symlink_loop: 'The requested cwd resolves through a symlink loop.',
  permission_denied: 'Permission denied when accessing the requested cwd.',
  not_allowed: 'The requested cwd is not in the allow-list.',
  probe_failed:
    'Filesystem case-sensitivity probe failed for the matched work root.',
}

// --- internal helpers --------------------------------------------------

function pushIfCanResolve(out: string[], root: string, fs: FileAccessLayer): void {
  try {
    const canonical = fs.realpathSync(root)
    if (!out.includes(canonical)) out.push(canonical)
  } catch {
    // Stale root (deleted directory etc.) — silently skip. Orphan
    // cleanup belongs to the bootstrap / setting reader.
  }
}

function persistMetadataBestEffort(
  fs: FileAccessLayer,
  setting: KovitoboardSetting,
  revision: number,
  nextMeta: Record<string, WorkRootMetadata>,
): void {
  try {
    writeSettingCas(
      fs,
      { ...setting, workRootsMetadata: nextMeta },
      revision,
    )
  } catch (err) {
    // CAS collision means another writer beat us to it — fine, the
    // next request will read the new state. Other errors get logged
    // at warn level; the in-memory snapshot is still usable.
    if (!(err instanceof SettingConflictError)) {
      precheckLog.warn(
        { err },
        '[cwd-precheck] Metadata persist failed (continuing with in-memory state)',
      )
    }
  }
}
