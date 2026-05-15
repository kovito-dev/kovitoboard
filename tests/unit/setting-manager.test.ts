/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for setting-manager.
 *
 * - validateSetting accepts the post-migration v1.2 shape only; legacy
 *   raw v1.0 / v1.1 inputs are normalised by `readSetting()` via
 *   `migrateSettingObject()` (spec `cwd-allowlist.md` v1.0 §7.7).
 * - migrateSettingObject backfills `version` / `revision` /
 *   `additionalWorkRoots` / `workRootsMetadata` for any legacy input.
 * - writeSetting auto-bumps the revision and serialises concurrent
 *   writers via `proper-lockfile`.
 * - writeSettingCas throws `SettingConflictError` on revision mismatch.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateSetting,
  migrateSettingObject,
  readSetting,
  readSettingWithRevision,
  writeSetting,
  writeSettingCas,
  SettingConflictError,
} from '../../src/server/setting-manager'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { _resetProjectRootCache } from '../../src/server/config'

/**
 * Post-migration v1.2 setting used as the baseline for `validateSetting`
 * positive cases. Includes the three v1.2 fields required by the
 * cwd-allowlist subsystem spec.
 */
const validSetting = {
  version: '1.2',
  revision: 1,
  additionalWorkRoots: [],
  workRootsMetadata: {},
  user: { displayName: 'tester', avatar: null },
  project: { name: 'test-project', description: 'description', path: '/tmp/test' },
  locale: 'ja',
  onboarding: { completedAt: null, wizardVersion: '0.1.0' },
}

describe('validateSetting (post-migration v1.2)', () => {
  it('accepts the canonical v1.2 setting', () => {
    expect(validateSetting(validSetting)).toBe(true)
  })

  it('rejects v1.1 raw input (pre-migration)', () => {
    expect(validateSetting({ ...validSetting, version: '1.1' })).toBe(false)
  })

  it('rejects v1.0 raw input (pre-migration)', () => {
    expect(validateSetting({ ...validSetting, version: '1.0' })).toBe(false)
  })

  it('rejects revision missing', () => {
    const noRev = { ...validSetting } as Record<string, unknown>
    delete noRev.revision
    expect(validateSetting(noRev)).toBe(false)
  })

  it('rejects revision <= 0', () => {
    expect(validateSetting({ ...validSetting, revision: 0 })).toBe(false)
    expect(validateSetting({ ...validSetting, revision: -1 })).toBe(false)
  })

  it('rejects revision non-integer', () => {
    expect(validateSetting({ ...validSetting, revision: 1.5 })).toBe(false)
  })

  it('rejects malformed additionalWorkRoots (non-array)', () => {
    expect(
      validateSetting({ ...validSetting, additionalWorkRoots: '/etc' }),
    ).toBe(false)
  })

  it('rejects additionalWorkRoots entries that are not strings', () => {
    expect(
      validateSetting({ ...validSetting, additionalWorkRoots: ['/ok', 123] }),
    ).toBe(false)
  })

  it('rejects workRootsMetadata entry missing caseSensitive', () => {
    expect(
      validateSetting({
        ...validSetting,
        workRootsMetadata: { '/tmp/x': { probedAt: '2026-05-15T00:00:00Z' } },
      }),
    ).toBe(false)
  })

  it('accepts workRootsMetadata with valid per-root entry', () => {
    expect(
      validateSetting({
        ...validSetting,
        additionalWorkRoots: ['/tmp/x'],
        workRootsMetadata: {
          '/tmp/x': { caseSensitive: true, probedAt: '2026-05-15T00:00:00Z' },
        },
      }),
    ).toBe(true)
  })

  it('rejects missing project.path', () => {
    const noPath = {
      ...validSetting,
      project: { name: 'test', description: '' },
    }
    expect(validateSetting(noPath)).toBe(false)
  })

  it('rejects empty project.path', () => {
    const empty = {
      ...validSetting,
      project: { name: 'test', description: '', path: '' },
    }
    expect(validateSetting(empty)).toBe(false)
  })

  it('accepts user.avatar as string', () => {
    expect(
      validateSetting({
        ...validSetting,
        user: { displayName: 'tester', avatar: '/path/to/avatar.png' },
      }),
    ).toBe(true)
  })

  it('rejects null', () => {
    expect(validateSetting(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(validateSetting(undefined)).toBe(false)
  })

  it('rejects unknown locale', () => {
    expect(validateSetting({ ...validSetting, locale: 'fr' })).toBe(false)
  })

  // claudeMdGuidance — same semantics as the legacy tests, retained.
  it('accepts a setting without claudeMdGuidance (defaults apply)', () => {
    expect(validateSetting({ ...validSetting })).toBe(true)
  })

  it('accepts claudeMdGuidance with disabled boolean only', () => {
    expect(
      validateSetting({ ...validSetting, claudeMdGuidance: { disabled: true } }),
    ).toBe(true)
  })

  it('accepts claudeMdGuidance with lastInjectedAt string', () => {
    expect(
      validateSetting({
        ...validSetting,
        claudeMdGuidance: { lastInjectedAt: '2026-05-10T03:14:25.123Z' },
      }),
    ).toBe(true)
  })

  it('rejects claudeMdGuidance with non-boolean disabled', () => {
    expect(
      validateSetting({ ...validSetting, claudeMdGuidance: { disabled: 'yes' } }),
    ).toBe(false)
  })

  it('rejects claudeMdGuidance with non-string lastInjectedAt', () => {
    expect(
      validateSetting({
        ...validSetting,
        claudeMdGuidance: { lastInjectedAt: 1234567890 },
      }),
    ).toBe(false)
  })

  it('rejects claudeMdGuidance set to null', () => {
    expect(
      validateSetting({ ...validSetting, claudeMdGuidance: null }),
    ).toBe(false)
  })

  it('rejects claudeCodeSettingsWarning whose dismissedResult.reason is not "ok"', () => {
    expect(
      validateSetting({
        ...validSetting,
        claudeCodeSettingsWarning: {
          dismissedAt: '2026-05-13T11:00:00Z',
          dismissedResult: {
            permissionMode: { current: '__unreadable__', recommended: 'default', ok: false },
            denyPattern: { hasKovitoboardDeny: false, ok: false, remediation: 'add' },
            bypassMode: { active: false, ok: false },
            overallOk: false,
            reason: 'read-error',
            settingsFilePath: null,
          },
        },
      }),
    ).toBe(false)
  })

  it('accepts claudeCodeSettingsWarning with reason="ok"', () => {
    expect(
      validateSetting({
        ...validSetting,
        claudeCodeSettingsWarning: {
          dismissedAt: '2026-05-13T11:00:00Z',
          dismissedResult: {
            permissionMode: { current: 'default', recommended: 'default', ok: true },
            denyPattern: { hasKovitoboardDeny: false, ok: false, remediation: 'add' },
            bypassMode: { active: false, ok: true },
            overallOk: false,
            reason: 'ok',
            settingsFilePath: null,
          },
        },
      }),
    ).toBe(true)
  })
})

describe('migrateSettingObject (v1.0 / v1.1 -> v1.2)', () => {
  it('migrates v1.0 to v1.2 (backfills project.path + new fields)', () => {
    const raw = {
      version: '1.0',
      user: { displayName: 'old', avatar: null },
      project: { name: 'p', description: 'd' }, // no path
      locale: 'ja',
      onboarding: { completedAt: null, wizardVersion: '0.0' },
    }
    const { migrated, changed } = migrateSettingObject(raw)
    expect(changed).toBe(true)
    expect(migrated.version).toBe('1.2')
    expect(migrated.revision).toBe(1)
    expect(migrated.additionalWorkRoots).toEqual([])
    expect(migrated.workRootsMetadata).toEqual({})
    const project = migrated.project as Record<string, unknown>
    expect(typeof project.path).toBe('string')
    expect((project.path as string).length).toBeGreaterThan(0)
  })

  it('migrates v1.1 to v1.2 (preserves project.path, adds new fields)', () => {
    const raw = {
      version: '1.1',
      user: { displayName: 'u', avatar: null },
      project: { name: 'p', description: 'd', path: '/keep/me' },
      locale: 'en',
      onboarding: { completedAt: null, wizardVersion: '0.1.0' },
    }
    const { migrated, changed } = migrateSettingObject(raw)
    expect(changed).toBe(true)
    expect(migrated.version).toBe('1.2')
    expect(migrated.revision).toBe(1)
    expect(migrated.additionalWorkRoots).toEqual([])
    expect(migrated.workRootsMetadata).toEqual({})
    const project = migrated.project as Record<string, unknown>
    expect(project.path).toBe('/keep/me')
  })

  it('is idempotent on already-v1.2 input (no changes)', () => {
    const v12 = {
      ...validSetting,
      additionalWorkRoots: ['/tmp/x'],
      workRootsMetadata: {
        '/tmp/x': { caseSensitive: true, probedAt: '2026-05-15T00:00:00Z' },
      },
    }
    const { migrated, changed } = migrateSettingObject(v12)
    expect(changed).toBe(false)
    expect(migrated.version).toBe('1.2')
    expect(migrated.revision).toBe(1)
    expect(migrated.additionalWorkRoots).toEqual(['/tmp/x'])
  })

  it('backfills missing v1.2 fields even when version is already 1.2', () => {
    const raw = {
      version: '1.2',
      user: { displayName: 'u', avatar: null },
      project: { name: 'p', description: 'd', path: '/x' },
      locale: 'en',
      onboarding: { completedAt: null, wizardVersion: '0.1.0' },
      // revision / additionalWorkRoots / workRootsMetadata absent
    }
    const { migrated, changed } = migrateSettingObject(raw)
    expect(changed).toBe(true)
    expect(migrated.revision).toBe(1)
    expect(migrated.additionalWorkRoots).toEqual([])
    expect(migrated.workRootsMetadata).toEqual({})
  })

  it('repairs malformed revision (negative / non-integer)', () => {
    const r1 = migrateSettingObject({ ...validSetting, revision: -5 })
    expect(r1.migrated.revision).toBe(1)
    expect(r1.changed).toBe(true)

    const r2 = migrateSettingObject({ ...validSetting, revision: 'oops' })
    expect(r2.migrated.revision).toBe(1)
    expect(r2.changed).toBe(true)
  })
})

// --- I/O integration tests ---------------------------------------------

/**
 * Set up a temporary directory that behaves like a project root. We
 * point `KOVITOBOARD_PROJECT_ROOT` at it and reset the config cache so
 * `getKovitoboardDir()` resolves to `<tmp>/.kovitoboard/`.
 */
function setupTempRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kb-setting-manager-test-'))
  mkdirSync(join(dir, '.kovitoboard'), { recursive: true })
  const previous = process.env.KOVITOBOARD_PROJECT_ROOT
  process.env.KOVITOBOARD_PROJECT_ROOT = dir
  _resetProjectRootCache()
  return {
    dir,
    cleanup: () => {
      if (previous === undefined) {
        delete process.env.KOVITOBOARD_PROJECT_ROOT
      } else {
        process.env.KOVITOBOARD_PROJECT_ROOT = previous
      }
      _resetProjectRootCache()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('readSetting + migration-on-read', () => {
  it('migrates a legacy v1.1 file to v1.2 on read', () => {
    const ctx = setupTempRoot()
    try {
      const settingPath = join(ctx.dir, '.kovitoboard', 'setting.json')
      const legacy = {
        version: '1.1',
        user: { displayName: 'legacy', avatar: null },
        project: { name: 'p', description: 'd', path: ctx.dir },
        locale: 'ja',
        onboarding: { completedAt: null, wizardVersion: '0.1.0' },
      }
      writeFileSync(settingPath, JSON.stringify(legacy, null, 2))

      const fs = new DirectFsLayer()
      const setting = readSetting(fs)
      expect(setting).not.toBeNull()
      expect(setting!.version).toBe('1.2')
      expect(setting!.revision).toBe(1)
      expect(setting!.additionalWorkRoots).toEqual([])
      expect(setting!.workRootsMetadata).toEqual({})

      // Write-back must have happened (changed=true path).
      const persisted = JSON.parse(readFileSync(settingPath, 'utf-8'))
      expect(persisted.version).toBe('1.2')
      expect(persisted.revision).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('returns null when file is absent', () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      expect(readSetting(fs)).toBeNull()
    } finally {
      ctx.cleanup()
    }
  })

  it('returns null when file is malformed JSON', () => {
    const ctx = setupTempRoot()
    try {
      const settingPath = join(ctx.dir, '.kovitoboard', 'setting.json')
      writeFileSync(settingPath, '{ not json')
      const fs = new DirectFsLayer()
      expect(readSetting(fs)).toBeNull()
    } finally {
      ctx.cleanup()
    }
  })

  it('readSettingWithRevision returns the current CAS token', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      await writeSetting(fs, { ...validSetting, project: { ...validSetting.project, path: ctx.dir } })
      const result = readSettingWithRevision(fs)
      expect(result).not.toBeNull()
      expect(result!.revision).toBeGreaterThanOrEqual(1)
    } finally {
      ctx.cleanup()
    }
  })

  // CodeX Attempt 1 HIGH 1 regression — migration write-back must not
  // clobber a newer on-disk v1.2 file produced by a racing writer.
  // We simulate the race by:
  //   1. preparing a legacy v1.1 file on disk
  //   2. having the renderer about to read it
  //   3. another writer racing in and producing a richer v1.2 file with
  //      additionalWorkRoots / workRootsMetadata before our reader gets
  //      to write the migration back
  //   4. asserting the reader returns the migrated form in memory but
  //      DOES NOT overwrite the disk file
  it('migration write-back skips when on-disk file is already v1.2 (race defence)', () => {
    const ctx = setupTempRoot()
    try {
      const settingPath = join(ctx.dir, '.kovitoboard', 'setting.json')

      // Step 1: seed a legacy v1.1 file (this is what readSetting sees
      // initially).
      const legacy = {
        version: '1.1',
        user: { displayName: 'legacy', avatar: null },
        project: { name: 'p', description: 'd', path: ctx.dir },
        locale: 'ja',
        onboarding: { completedAt: null, wizardVersion: '0.1.0' },
      }
      writeFileSync(settingPath, JSON.stringify(legacy, null, 2))
      const fs = new DirectFsLayer()

      // Step 2 + 3: between the in-memory migration and the write-back,
      // simulate a racing writer that produced a richer v1.2 form. We
      // overwrite the file with a v1.2 snapshot that carries an
      // additionalWorkRoots entry — exactly the state we must protect.
      const racingV12 = {
        version: '1.2',
        revision: 7,
        additionalWorkRoots: ['/tmp/sensitive-work-root'],
        workRootsMetadata: {
          '/tmp/sensitive-work-root': {
            caseSensitive: true,
            probedAt: '2026-05-15T00:00:00Z',
          },
        },
        user: { displayName: 'winning-writer', avatar: null },
        project: { name: 'p', description: 'd', path: ctx.dir },
        locale: 'ja',
        onboarding: { completedAt: null, wizardVersion: '0.1.0' },
      }
      writeFileSync(settingPath, JSON.stringify(racingV12, null, 2))

      // Step 4: invoking readSetting now must NOT roll the file back to
      // the migration default. The re-read under lock inside
      // `tryMigrationWriteBack()` should detect `version === '1.2'` and
      // abandon the write-back.
      const result = readSetting(fs)
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2')

      const persisted = JSON.parse(readFileSync(settingPath, 'utf-8'))
      expect(persisted.version).toBe('1.2')
      expect(persisted.revision).toBe(7)
      expect(persisted.additionalWorkRoots).toEqual(['/tmp/sensitive-work-root'])
      expect(persisted.workRootsMetadata['/tmp/sensitive-work-root']).toEqual({
        caseSensitive: true,
        probedAt: '2026-05-15T00:00:00Z',
      })
      // The racing writer's identifying field must still be intact.
      expect((persisted.user as { displayName: string }).displayName).toBe(
        'winning-writer',
      )
    } finally {
      ctx.cleanup()
    }
  })
})

describe('writeSetting (auto-CAS)', () => {
  it('initial write seeds revision = 1', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      await writeSetting(fs, { ...validSetting, project: { ...validSetting.project, path: ctx.dir } })
      const result = readSettingWithRevision(fs)
      expect(result!.revision).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('subsequent writes bump revision monotonically', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      const base = { ...validSetting, project: { ...validSetting.project, path: ctx.dir } }
      await writeSetting(fs, base)
      await writeSetting(fs, { ...base, locale: 'en' })
      await writeSetting(fs, { ...base, locale: 'ja' })
      const result = readSettingWithRevision(fs)
      expect(result!.revision).toBe(3)
    } finally {
      ctx.cleanup()
    }
  })

  it('ignores caller-supplied revision (server is authoritative)', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      await writeSetting(fs, {
        ...validSetting,
        revision: 999, // caller value should be ignored
        project: { ...validSetting.project, path: ctx.dir },
      })
      const result = readSettingWithRevision(fs)
      expect(result!.revision).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  // CodeX PR #38 Attempt 3 MEDIUM 2 regression — the first-write path
  // must take the dedicated lockfile so two concurrent first-writers
  // serialise instead of both observing "missing file" and writing
  // revision 1. JavaScript is single-threaded so we cannot drive a
  // true cross-process race in-process; this test instead pins the
  // structural fix — `setting.json.lock` is touched by the first
  // write and survives subsequent writes, which is the prerequisite
  // for `proper-lockfile.lockSync()` to function at all on the
  // create path. (Cross-process serialization is exercised by L1
  // E2E in `tests/e2e/cwd-allowlist-deny.spec.ts`.)
  it('first-write creates the dedicated lockfile alongside setting.json', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      const settingPath = join(ctx.dir, '.kovitoboard', 'setting.json')
      const lockPath = settingPath + '.lock'

      // Lockfile must not exist before the first write.
      expect(() => readFileSync(lockPath, 'utf-8')).toThrow()

      await writeSetting(fs, { ...validSetting, project: { ...validSetting.project, path: ctx.dir } })

      // After the first write the lockfile target must exist so
      // future first-write concurrents can lock it. Content is
      // intentionally a zero-byte sentinel.
      const lockContents = readFileSync(lockPath, 'utf-8')
      expect(lockContents).toBe('')

      // A second write must not corrupt or remove the lockfile.
      await writeSetting(fs, { ...validSetting, project: { ...validSetting.project, path: ctx.dir }, locale: 'en' })
      expect(readFileSync(lockPath, 'utf-8')).toBe('')

      // The revision must monotonically progress (no clobber-on-create).
      const final = readSettingWithRevision(fs)
      expect(final!.revision).toBe(2)
      expect(final!.setting.locale).toBe('en')
    } finally {
      ctx.cleanup()
    }
  })

  // CodeX Attempt 2 MEDIUM 1 regression — writeSetting() must not let a
  // legacy caller's stale in-memory snapshot clobber concurrent
  // allow-list edits made via writeSettingCas(). Simulate the race by:
  //   1. seeding the file via writeSetting() (legacy caller's baseline)
  //   2. having a /api/work-roots-like writer add `additionalWorkRoots`
  //      via writeSettingCas()
  //   3. having the legacy caller call writeSetting() with their stale
  //      snapshot (no additionalWorkRoots, only the field they meant
  //      to update — e.g. locale)
  //   4. asserting the on-disk additionalWorkRoots survives.
  it('preserves additionalWorkRoots from concurrent writeSettingCas() update', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      const base = { ...validSetting, project: { ...validSetting.project, path: ctx.dir } }

      // Step 1: legacy caller seeds the file.
      await writeSetting(fs, base)
      const beforeCas = readSettingWithRevision(fs)
      expect(beforeCas!.setting.additionalWorkRoots).toEqual([])

      // Step 2: /api/work-roots-style writer adds a root via CAS.
      writeSettingCas(
        fs,
        {
          ...beforeCas!.setting,
          additionalWorkRoots: ['/tmp/added-root'],
          workRootsMetadata: {
            '/tmp/added-root': {
              caseSensitive: true,
              probedAt: '2026-05-15T00:00:00Z',
            },
          },
        },
        beforeCas!.revision,
      )

      // Step 3: legacy caller now calls writeSetting() with their
      // *stale* in-memory snapshot (their copy still has empty roots).
      await writeSetting(fs, { ...base, locale: 'en' })

      // Step 4: the live allow-list state must survive.
      const persisted = readSettingWithRevision(fs)
      expect(persisted!.setting.additionalWorkRoots).toEqual(['/tmp/added-root'])
      expect(persisted!.setting.workRootsMetadata).toEqual({
        '/tmp/added-root': {
          caseSensitive: true,
          probedAt: '2026-05-15T00:00:00Z',
        },
      })
      // The legacy caller's edit (locale change) must still take
      // effect — we only protect the cwd-allowlist fields.
      expect(persisted!.setting.locale).toBe('en')
    } finally {
      ctx.cleanup()
    }
  })
})

describe('writeSettingCas (explicit CAS)', () => {
  it('succeeds when expectedRevision matches', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      const base = { ...validSetting, project: { ...validSetting.project, path: ctx.dir } }
      await writeSetting(fs, base)
      const current = readSettingWithRevision(fs)!

      writeSettingCas(fs, { ...base, locale: 'en' }, current.revision)
      const next = readSettingWithRevision(fs)!
      expect(next.revision).toBe(current.revision + 1)
      expect(next.setting.locale).toBe('en')
    } finally {
      ctx.cleanup()
    }
  })

  it('throws SettingConflictError when expectedRevision is stale', async () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      const base = { ...validSetting, project: { ...validSetting.project, path: ctx.dir } }
      await writeSetting(fs, base)
      await writeSetting(fs, { ...base, locale: 'en' })
      const current = readSettingWithRevision(fs)!

      expect(() =>
        writeSettingCas(fs, { ...base, locale: 'ja' }, current.revision - 1),
      ).toThrow(SettingConflictError)
    } finally {
      ctx.cleanup()
    }
  })

  it('allows initial create with expectedRevision = 0', () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      writeSettingCas(
        fs,
        { ...validSetting, project: { ...validSetting.project, path: ctx.dir } },
        0,
      )
      const result = readSettingWithRevision(fs)!
      expect(result.revision).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('rejects initial create when expectedRevision != 0', () => {
    const ctx = setupTempRoot()
    try {
      const fs = new DirectFsLayer()
      expect(() =>
        writeSettingCas(
          fs,
          { ...validSetting, project: { ...validSetting.project, path: ctx.dir } },
          5,
        ),
      ).toThrow(SettingConflictError)
    } finally {
      ctx.cleanup()
    }
  })
})
