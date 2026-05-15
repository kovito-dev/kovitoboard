/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard settings file (.kovitoboard/setting.json) read/write.
 *
 * Designed to receive a FileAccessLayer.
 * Validation is implemented manually (without zod).
 *
 * Schema versioning SSOT — `cwd-allowlist.md` v1.0 §6.1 / §7.5 / §7.7:
 *   - In-memory representation always carries `version: '1.2'`.
 *   - Legacy v1.0 (no `project.path`) and v1.1 files are normalised at
 *     read time via `migrateSettingObject()` so callers can rely on
 *     `revision` / `additionalWorkRoots` / `workRootsMetadata` being
 *     present.
 *   - Concurrent writers are serialised through `proper-lockfile`, and
 *     `revision` acts as a compare-and-swap (CAS) token (§7.5).
 *     `writeSetting()` auto-bumps the revision and retries collisions
 *     internally so existing callers keep their sync ergonomics.
 *     `writeSettingCas()` exposes explicit CAS for callers that need to
 *     drive their own retry policy (e.g. `/api/work-roots`).
 */
import lockfile from 'proper-lockfile'
import { lazyChildLogger } from './logger'

const settingLog = lazyChildLogger('setting-manager')
import { join } from 'path'
import { getKovitoboardDir } from './paths'
import type { FileAccessLayer } from './fs-layer'
import type {
  KovitoboardSetting,
  WorkRootMetadata,
} from '../shared/setting-types'

const SETTING_FILENAME = 'setting.json'

/**
 * Maximum number of internal retries when `writeSetting()` encounters a
 * CAS collision. Matches spec §7.5 (up to 3 retries) with exponential
 * backoff.
 */
const CAS_MAX_RETRIES = 3
const CAS_BACKOFF_MS = [50, 100, 200] as const

/**
 * `proper-lockfile.lockSync` options. The sync entrypoint does not
 * accept a `retries` profile (the underlying adapter throws "Cannot use
 * retries with the sync api"), so callers are responsible for retrying
 * — `writeSetting` already does so as part of the CAS loop, and
 * `writeSettingCas` surfaces lock failures as `SettingConflictError` so
 * the HTTP layer can retry. `stale` is intentionally short so a crashed
 * writer cannot wedge subsequent attempts.
 */
const LOCK_OPTIONS = {
  realpath: false as const,
  stale: 5000,
} as const

/** Suffix appended to the setting path for the dedicated lockfile. */
const LOCKFILE_SUFFIX = '.lock'

/**
 * Thrown by `writeSettingCas()` when the on-disk revision no longer
 * matches the caller's `expectedRevision`. Callers translate this to
 * HTTP 409 (`setting_collision`) once their own retry budget is
 * exhausted (spec §6.2.2 / §7.5).
 */
export class SettingConflictError extends Error {
  readonly expectedRevision: number
  readonly actualRevision: number
  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Setting revision mismatch: expected ${expectedRevision}, got ${actualRevision}`,
    )
    this.name = 'SettingConflictError'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

/** Return the path to .kovitoboard/setting.json */
export function getSettingPath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), SETTING_FILENAME)
}

/**
 * Return the path to the dedicated lockfile sitting alongside the
 * setting file (`<setting.json>.lock`). We use a separate lockfile —
 * not `setting.json` itself — so the lock can be acquired even before
 * `setting.json` exists, which is what makes the create path race-safe
 * (CodeX PR #38 Attempt 3 MEDIUM 2).
 */
function getLockfilePath(fs: FileAccessLayer): string {
  return getSettingPath(fs) + LOCKFILE_SUFFIX
}

/**
 * Ensure the dedicated lockfile exists so `lockfile.lockSync()` can
 * target it. Returns the lockfile path.
 *
 * `proper-lockfile.lockSync` requires its target to exist on disk
 * (the underlying adapter checks the path before installing the
 * platform-specific lock primitive). By touching a zero-byte
 * `<setting.json>.lock` we make the lock available regardless of
 * whether `setting.json` has been created yet, so two concurrent
 * first-writes serialise on the lockfile instead of both observing
 * "missing file" and both writing revision 1.
 */
function ensureLockfile(fs: FileAccessLayer): string {
  ensureDir(fs)
  const lockPath = getLockfilePath(fs)
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, '')
  }
  return lockPath
}

/**
 * Read the settings file. Returns null if the file does not exist or is
 * malformed. Applies migration-on-read (§7.7) for legacy v1.0 / v1.1
 * schemas.
 */
export function readSetting(fs: FileAccessLayer): KovitoboardSetting | null {
  const result = readSettingInternal(fs)
  return result?.setting ?? null
}

/**
 * Read the settings file together with its current CAS token (§7.5).
 * Returns null with the same fail-quiet contract as `readSetting`.
 */
export function readSettingWithRevision(
  fs: FileAccessLayer,
): { setting: KovitoboardSetting; revision: number } | null {
  const result = readSettingInternal(fs)
  if (!result) return null
  return { setting: result.setting, revision: result.setting.revision }
}

/**
 * Write the settings data with automatic CAS bump (§7.5). Reads the
 * current revision under lock, increments it, and writes atomically.
 * Retries up to `CAS_MAX_RETRIES` on collision before throwing the
 * underlying error to the caller. Existing 4 callers
 * (`config-routes`, `security-routes`, `user-avatar-routes`, the
 * `/api/setting` PUT in `index.ts`) keep their synchronous call shape;
 * the only behavioural change is that the value in `data.revision` is
 * discarded — the new revision is always derived from disk state.
 */
export function writeSetting(fs: FileAccessLayer, data: KovitoboardSetting): void {
  const settingPath = getSettingPath(fs)
  // Touch the dedicated lockfile so both the create path and the
  // CAS-update path serialise on the same lock target (CodeX PR #38
  // Attempt 3 MEDIUM 2). Skipping the lock for first-write would let
  // two concurrent callers both observe "missing file" and both write
  // revision 1, silently clobbering one another.
  const lockPath = ensureLockfile(fs)

  let attempt = 0
  let lastErr: unknown
  while (attempt < CAS_MAX_RETRIES) {
    let release: (() => void) | null = null
    try {
      release = lockfile.lockSync(lockPath, LOCK_OPTIONS)
      // We hold the lock, so suppress migration write-back to avoid
      // `tryMigrationWriteBack()` re-taking the same lock (which would
      // throw `ELOCKED` and silently abort the migration).
      const current = readSettingInternal(fs, { skipMigrationWriteBack: true })
      if (!fs.existsSync(settingPath)) {
        // First-write path, now executed under the lock so concurrent
        // first-writers serialise here instead of racing on revision 1.
        writeAtomic(fs, normaliseV12(data, 1))
        return
      }
      const currentRevision = current?.setting.revision ?? 0
      // Protect cwd-allowlist subsystem fields against stale-snapshot
      // overwrites from the four legacy callers (`config-routes`,
      // `security-routes`, `user-avatar-routes`, the `/api/setting` PUT
      // inside `index.ts`). Spec `cwd-allowlist.md` v1.0 §5.3 designates
      // `additionalWorkRoots[]` / `workRootsMetadata` as "protected
      // fields" — only `writeSettingCas()` (driven by `/api/work-roots`)
      // owns mutations. Carrying the on-disk values forward here means
      // a legacy caller whose in-memory snapshot pre-dates a concurrent
      // allow-list edit can never erase that edit (CodeX Attempt 2
      // MEDIUM 1).
      const preserved = preserveAllowListFields(data, current?.setting)
      writeAtomic(fs, normaliseV12(preserved, currentRevision + 1))
      return
    } catch (err) {
      lastErr = err
      settingLog.warn(
        { err, attempt },
        '[setting-manager] writeSetting attempt failed, will retry',
      )
    } finally {
      if (release) {
        try {
          release()
        } catch (releaseErr) {
          settingLog.warn(
            { err: releaseErr },
            '[setting-manager] Lock release failed',
          )
        }
      }
    }
    sleepSync(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)])
    attempt++
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('[setting-manager] writeSetting failed after retries')
}

/**
 * Compare-and-swap write (§7.5). Throws `SettingConflictError` when the
 * on-disk revision differs from `expectedRevision`. Callers own the
 * retry policy — `/api/work-roots` retries up to 3× with exponential
 * backoff and surfaces HTTP 409 / `setting_collision` once exhausted
 * (spec §6.2.2).
 */
export function writeSettingCas(
  fs: FileAccessLayer,
  data: KovitoboardSetting,
  expectedRevision: number,
): void {
  const settingPath = getSettingPath(fs)
  // Acquire the dedicated lockfile before the existence check so the
  // create path serialises with concurrent first-writers (CodeX PR #38
  // Attempt 3 MEDIUM 2). Two callers each with `expectedRevision === 0`
  // would otherwise both see "missing file" and both write revision 1.
  const lockPath = ensureLockfile(fs)

  let release: (() => void) | null = null
  try {
    release = lockfile.lockSync(lockPath, LOCK_OPTIONS)
    // We hold the lock; suppress migration write-back so
    // `tryMigrationWriteBack()` does not re-take the lock (same-process
    // recursive lock would surface as `ELOCKED`).
    if (!fs.existsSync(settingPath)) {
      // First-write path under the lock. `expectedRevision === 0`
      // means "I read no file"; any other value indicates the caller
      // expected an existing revision, so surface a conflict.
      if (expectedRevision !== 0) {
        throw new SettingConflictError(expectedRevision, 0)
      }
      writeAtomic(fs, normaliseV12(data, 1))
      return
    }
    const current = readSettingInternal(fs, { skipMigrationWriteBack: true })
    const currentRevision = current?.setting.revision ?? 0
    if (currentRevision !== expectedRevision) {
      throw new SettingConflictError(expectedRevision, currentRevision)
    }
    writeAtomic(fs, normaliseV12(data, currentRevision + 1))
  } finally {
    if (release) {
      try {
        release()
      } catch (releaseErr) {
        settingLog.warn(
          { err: releaseErr },
          '[setting-manager] Lock release failed',
        )
      }
    }
  }
}

/**
 * Migrate a raw parsed setting object to the v1.2 schema. Pure function
 * (no I/O). Normative migration rules — spec `cwd-allowlist.md` v1.0
 * §7.7:
 *   - v1.0 inputs gain a backfilled `project.path` (legacy behaviour
 *     preserved).
 *   - v1.0 / v1.1 inputs are rewritten to `version: '1.2'`.
 *   - Missing `revision` / `additionalWorkRoots` / `workRootsMetadata`
 *     are backfilled regardless of the source version so newer fields
 *     introduced inside v1.2 future minor revs do not break legacy
 *     readers.
 *   - Returns `{ migrated, changed }` so the caller decides whether to
 *     write-back the normalised form.
 *
 * Exported for unit testing.
 */
export function migrateSettingObject(
  raw: Record<string, unknown>,
): { migrated: Record<string, unknown>; changed: boolean } {
  let changed = false
  const out: Record<string, unknown> = { ...raw }

  // v1.0 → v1.1: backfill project.path before bumping further.
  if (out.version === '1.0') {
    const project = (out.project ?? {}) as Record<string, unknown>
    if (typeof project.path !== 'string' || project.path.length === 0) {
      project.path = process.cwd()
    }
    out.project = project
    out.version = '1.1'
    changed = true
  }

  // Normalise version to '1.2'. Any other unknown / missing version is
  // treated as "needs migration" so a hand-edited file with a missing
  // field is repaired instead of rejected.
  if (out.version !== '1.2') {
    out.version = '1.2'
    changed = true
  }

  // revision: monotonic positive integer; default 1 when missing /
  // malformed.
  if (
    typeof out.revision !== 'number' ||
    !Number.isFinite(out.revision) ||
    out.revision < 1 ||
    !Number.isInteger(out.revision)
  ) {
    out.revision = 1
    changed = true
  }

  if (!Array.isArray(out.additionalWorkRoots)) {
    out.additionalWorkRoots = []
    changed = true
  }

  if (
    out.workRootsMetadata === undefined ||
    out.workRootsMetadata === null ||
    typeof out.workRootsMetadata !== 'object' ||
    Array.isArray(out.workRootsMetadata)
  ) {
    out.workRootsMetadata = {}
    changed = true
  }

  return { migrated: out, changed }
}

/** Manual validation (without zod) — accepts only the post-migration v1.2 shape. */
export function validateSetting(data: unknown): data is KovitoboardSetting {
  if (data === null || typeof data !== 'object') return false

  const obj = data as Record<string, unknown>

  // version: must be the post-migration form. Raw v1.0 / v1.1 files are
  // accepted by `readSetting()` via migration; `validateSetting()` runs
  // after migration so the only valid version here is '1.2'.
  if (obj.version !== '1.2') return false

  // revision: monotonic positive integer (§6.1).
  if (
    typeof obj.revision !== 'number' ||
    !Number.isFinite(obj.revision) ||
    obj.revision < 1 ||
    !Number.isInteger(obj.revision)
  ) {
    return false
  }

  // additionalWorkRoots: optional in TS, but post-migration it is
  // guaranteed-initialised (§6.1 SSOT). Accept missing for forward
  // compatibility with hand-edited files (will be backfilled on next
  // write).
  if (obj.additionalWorkRoots !== undefined) {
    if (!Array.isArray(obj.additionalWorkRoots)) return false
    for (const entry of obj.additionalWorkRoots) {
      if (typeof entry !== 'string' || entry.length === 0) return false
    }
  }

  // workRootsMetadata: same optionality contract as above.
  if (obj.workRootsMetadata !== undefined) {
    if (
      obj.workRootsMetadata === null ||
      typeof obj.workRootsMetadata !== 'object' ||
      Array.isArray(obj.workRootsMetadata)
    ) {
      return false
    }
    for (const meta of Object.values(
      obj.workRootsMetadata as Record<string, unknown>,
    )) {
      if (meta === null || typeof meta !== 'object') return false
      const m = meta as Record<string, unknown>
      if (typeof m.caseSensitive !== 'boolean') return false
      if (typeof m.probedAt !== 'string' || m.probedAt.length === 0) return false
    }
  }

  // user
  if (obj.user === null || typeof obj.user !== 'object') return false
  const user = obj.user as Record<string, unknown>
  if (typeof user.displayName !== 'string') return false
  if (user.avatar !== null && typeof user.avatar !== 'string') return false

  // project
  if (obj.project === null || typeof obj.project !== 'object') return false
  const project = obj.project as Record<string, unknown>
  if (typeof project.name !== 'string') return false
  if (typeof project.description !== 'string') return false
  if (typeof project.path !== 'string') return false
  if (project.path.length === 0) return false

  // locale
  if (obj.locale !== 'ja' && obj.locale !== 'en') return false

  // onboarding
  if (obj.onboarding === null || typeof obj.onboarding !== 'object') return false
  const onboarding = obj.onboarding as Record<string, unknown>
  if (onboarding.completedAt !== null && typeof onboarding.completedAt !== 'string') return false
  if (typeof onboarding.wizardVersion !== 'string') return false
  // `securityRecommendationsReviewedAt` is optional; only validate type
  // when present so older setting files without the field continue to
  // load. Spec handoff v1.1 §3.4.3.
  if (
    onboarding.securityRecommendationsReviewedAt !== undefined &&
    typeof onboarding.securityRecommendationsReviewedAt !== 'string'
  ) {
    return false
  }

  // ambientSidebar (optional, DEC-020 / EU8)
  if (obj.ambientSidebar !== undefined) {
    if (obj.ambientSidebar === null || typeof obj.ambientSidebar !== 'object') return false
    const amb = obj.ambientSidebar as Record<string, unknown>
    // pinned: Record<string, string | null>
    if (amb.pinned === null || typeof amb.pinned !== 'object') return false
    for (const v of Object.values(amb.pinned as Record<string, unknown>)) {
      if (v !== null && typeof v !== 'string') return false
    }
    // globalDefault: string | null
    if (amb.globalDefault !== null && typeof amb.globalDefault !== 'string') return false
    // openByDefault: boolean
    if (typeof amb.openByDefault !== 'boolean') return false
  }

  // versionCheck (optional, v0.1.0-version-display.md §3.3)
  if (obj.versionCheck !== undefined) {
    if (obj.versionCheck === null || typeof obj.versionCheck !== 'object') return false
    const vc = obj.versionCheck as Record<string, unknown>
    if (typeof vc.enabled !== 'boolean') return false
    if (typeof vc.ttlHours !== 'number') return false
    if (!Number.isFinite(vc.ttlHours) || vc.ttlHours < 1 || vc.ttlHours > 168) return false
  }

  // claudeMdGuidance (optional, claude-md-guidance-injection.md §7.1).
  // Both inner fields are optional; we accept the struct as long as the
  // present fields have the right type. Missing struct == defaults
  // (`disabled = false`, no `lastInjectedAt`).
  if (obj.claudeMdGuidance !== undefined) {
    if (obj.claudeMdGuidance === null || typeof obj.claudeMdGuidance !== 'object') {
      return false
    }
    const cmg = obj.claudeMdGuidance as Record<string, unknown>
    if (cmg.disabled !== undefined && typeof cmg.disabled !== 'boolean') return false
    if (cmg.lastInjectedAt !== undefined && typeof cmg.lastInjectedAt !== 'string') {
      return false
    }
  }

  // claudeCodeSettingsWarning (optional, handoff v1.1 §3.5 / §8.2 T-2-3).
  // The struct persists the user's dismiss decision so we can honor a
  // 24-hour cooldown across restarts. We only verify the shape here;
  // the temporal bounds check (T-2-3 mitigation, `dismissedAt <= now +
  // 24h`) is enforced at consumption time in
  // `claude-code-settings-check.ts` so that a future-dated value
  // injected directly into the file cannot keep the warning suppressed
  // indefinitely.
  if (obj.claudeCodeSettingsWarning !== undefined) {
    if (
      obj.claudeCodeSettingsWarning === null ||
      typeof obj.claudeCodeSettingsWarning !== 'object'
    ) {
      return false
    }
    const cw = obj.claudeCodeSettingsWarning as Record<string, unknown>
    if (typeof cw.dismissedAt !== 'string') return false
    if (cw.dismissedResult === null || typeof cw.dismissedResult !== 'object') {
      return false
    }
    const dr = cw.dismissedResult as Record<string, unknown>
    // Minimum required shape — the consumer (check helper) is the
    // canonical interpreter; we just reject obviously-malformed
    // structures so other reads do not crash later.
    if (typeof dr.overallOk !== 'boolean') return false
    if (typeof dr.reason !== 'string') return false
    if (dr.permissionMode === null || typeof dr.permissionMode !== 'object') return false
    if (dr.denyPattern === null || typeof dr.denyPattern !== 'object') return false
    if (dr.bypassMode === null || typeof dr.bypassMode !== 'object') return false
    // CodeX attempt 11 — defense-in-depth: a persisted dismiss
    // snapshot is only meaningful when it captures a non-fail-closed
    // check result. Reject saved records whose `reason !== 'ok'` so a
    // crafted file cannot keep an "unreadable settings" warning
    // suppressed across reads. The HTTP dismiss endpoint already
    // refuses to write such a record server-side; this validator
    // closes the equivalent loophole for direct on-disk edits.
    if (dr.reason !== 'ok') return false
  }

  return true
}

// --- internal helpers ---------------------------------------------------

/**
 * Options for the internal reader.
 *
 * `skipMigrationWriteBack` is set by `writeSetting()` / `writeSettingCas()`
 * which are *already* holding the setting-file lock when they invoke
 * `readSettingInternal()`. `tryMigrationWriteBack()` re-takes the same
 * lock via `proper-lockfile.lockSync`, which would surface as `ELOCKED`
 * inside the same process and abort the migration. Suppressing the
 * write-back from those call sites keeps the write paths deadlock-free;
 * the migration still happens on the next plain `readSetting()` call.
 */
type ReadSettingOptions = { skipMigrationWriteBack?: boolean }

function readSettingInternal(
  fs: FileAccessLayer,
  options: ReadSettingOptions = {},
): { setting: KovitoboardSetting } | null {
  const settingPath = getSettingPath(fs)
  if (!fs.existsSync(settingPath)) return null

  let raw: Record<string, unknown>
  try {
    const text = fs.readFileSync(settingPath, 'utf-8')
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (err) {
    settingLog.error({ err }, '[setting-manager] Failed to read setting:')
    return null
  }

  const previousVersion = raw.version
  const { migrated, changed } = migrateSettingObject(raw)

  if (changed && !options.skipMigrationWriteBack) {
    tryMigrationWriteBack(fs, settingPath, previousVersion, migrated)
  }

  if (!validateSetting(migrated)) {
    settingLog.warn(
      '[setting-manager] Invalid setting file after migration, returning null',
    )
    return null
  }
  return { setting: migrated }
}

/**
 * Persist the migrated form back to disk under the same `proper-lockfile`
 * lock that the write paths use. Re-reads the on-disk file *inside* the
 * lock; if another writer has already promoted the file to v1.2 we
 * abandon the write-back rather than clobbering newer state (CodeX
 * Attempt 1 HIGH 1). The cwd allow-list — `additionalWorkRoots[]` /
 * `workRootsMetadata` / `revision` — is persisted here, so a stale
 * migration overwrite would be a security-relevant state loss.
 *
 * Failures are swallowed: callers continue with the in-memory migrated
 * form, matching the prior best-effort contract of migration-on-read.
 */
function tryMigrationWriteBack(
  fs: FileAccessLayer,
  settingPath: string,
  previousVersion: unknown,
  migrated: Record<string, unknown>,
): void {
  let release: (() => void) | null = null
  try {
    // Use the dedicated lockfile so we serialise with `writeSetting`
    // / `writeSettingCas` (which now lock the same path).
    const lockPath = ensureLockfile(fs)
    release = lockfile.lockSync(lockPath, LOCK_OPTIONS)

    // Re-read under lock. If the file is already v1.2, another writer
    // has migrated it in the meantime — abandon our write-back so we
    // do not roll their `additionalWorkRoots` / `workRootsMetadata` /
    // `revision` back to the migration default.
    let currentRaw: Record<string, unknown>
    try {
      const text = fs.readFileSync(settingPath, 'utf-8')
      currentRaw = JSON.parse(text) as Record<string, unknown>
    } catch (readErr) {
      settingLog.warn(
        { err: readErr },
        '[setting-manager] Migration write-back skipped: re-read under lock failed',
      )
      return
    }
    if (currentRaw.version === '1.2') {
      settingLog.debug(
        '[setting-manager] Migration write-back skipped: concurrent writer already promoted file to v1.2',
      )
      return
    }

    writeAtomic(fs, migrated as unknown as KovitoboardSetting)
    settingLog.info(
      { fromVersion: previousVersion, toVersion: '1.2' },
      '[setting-manager] Migrated setting.json',
    )
  } catch (writeErr) {
    settingLog.warn(
      { err: writeErr },
      '[setting-manager] Migration write-back failed; continuing in memory',
    )
  } finally {
    if (release) {
      try {
        release()
      } catch (releaseErr) {
        settingLog.warn(
          { err: releaseErr },
          '[setting-manager] Lock release failed',
        )
      }
    }
  }
}

/**
 * Construct the canonical v1.2 form of the supplied setting, overriding
 * `version` / `revision` and ensuring the new fields are present. The
 * `additionalWorkRoots` / `workRootsMetadata` fields are preserved
 * verbatim when supplied so write-paths that legitimately update them
 * (e.g. `/api/work-roots`) round-trip cleanly.
 */
function normaliseV12(
  data: KovitoboardSetting,
  revision: number,
): KovitoboardSetting {
  const next: KovitoboardSetting = {
    ...data,
    version: '1.2',
    revision,
  }
  if (next.additionalWorkRoots === undefined) {
    next.additionalWorkRoots = []
  }
  if (next.workRootsMetadata === undefined) {
    next.workRootsMetadata = {} as Record<string, WorkRootMetadata>
  }
  return next
}

function ensureDir(fs: FileAccessLayer): void {
  const dir = getKovitoboardDir(fs)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function writeAtomic(fs: FileAccessLayer, data: KovitoboardSetting): void {
  const settingPath = getSettingPath(fs)
  ensureDir(fs)
  fs.writeFileAtomic(settingPath, JSON.stringify(data, null, 2) + '\n')
}

/**
 * Carry the cwd-allowlist subsystem fields from the on-disk setting
 * into the caller-supplied snapshot before the write. The four legacy
 * `writeSetting()` callers do not edit these fields (spec §5.3 marks
 * them as protected and routes mutations through `/api/work-roots` →
 * `writeSettingCas()`), so preserving them is always safe and prevents
 * a stale snapshot from silently erasing concurrent allow-list state.
 *
 * Falls back to the caller's value (or the spec defaults) when the
 * on-disk read returned nothing (e.g. fresh install before
 * `writeSetting` ran).
 */
function preserveAllowListFields(
  data: KovitoboardSetting,
  onDisk: KovitoboardSetting | undefined,
): KovitoboardSetting {
  if (!onDisk) return data
  return {
    ...data,
    additionalWorkRoots:
      onDisk.additionalWorkRoots ?? data.additionalWorkRoots ?? [],
    workRootsMetadata:
      onDisk.workRootsMetadata ?? data.workRootsMetadata ?? {},
  }
}

/**
 * Synchronous sleep used only between CAS retries inside the legacy
 * `writeSetting()` path to give the lock-holder a chance to release the
 * lock. `Atomics.wait` blocks the thread without burning CPU and is the
 * recommended pattern for the tiny waits we want (≤ 200 ms).
 *
 * Why sync (instead of `await setTimeout`):
 *   `writeSetting()` is sync by contract (spec `cwd-allowlist.md` v1.0
 *   §7.5 — "writeSetting() keeps its synchronous shape"), preserving
 *   the call shape of the four pre-existing callers (`config-routes`,
 *   `security-routes`, `user-avatar-routes`, the setting PUT inside
 *   `index.ts`). The blocking window is bounded — total sleep across
 *   the CAS budget is 50 + 100 + 200 = 350 ms max.
 *
 *   New explicit-CAS callers (`/api/work-roots`) use the async retry
 *   helper inside `work-roots-routes.ts` so contention there does not
 *   stall the event loop.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  const shared = new SharedArrayBuffer(4)
  const view = new Int32Array(shared)
  Atomics.wait(view, 0, 0, ms)
}
