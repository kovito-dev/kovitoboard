/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for setting-manager
 *
 * validateSetting: v1.1 schema validation (project.path required)
 * readSetting: 1.0 -> 1.1 migration
 */
import { describe, it, expect } from 'vitest'
import { validateSetting } from '../../src/server/setting-manager'

const validSetting = {
  version: '1.1',
  user: { displayName: 'テスト', avatar: null },
  project: { name: 'test-project', description: '概要', path: '/tmp/test' },
  locale: 'ja',
  onboarding: { completedAt: null, wizardVersion: '0.1.0' },
}

describe('validateSetting', () => {
  it('正常な v1.1 設定を受け入れる', () => {
    expect(validateSetting(validSetting)).toBe(true)
  })

  it('v1.0 は拒否する（マイグレーション前）', () => {
    expect(validateSetting({ ...validSetting, version: '1.0' })).toBe(false)
  })

  it('project.path が必須', () => {
    const noPath = {
      ...validSetting,
      project: { name: 'test', description: '' },
    }
    expect(validateSetting(noPath)).toBe(false)
  })

  it('project.path が空文字は拒否', () => {
    const emptyPath = {
      ...validSetting,
      project: { name: 'test', description: '', path: '' },
    }
    expect(validateSetting(emptyPath)).toBe(false)
  })

  it('avatar が string の場合も受け入れる', () => {
    const withAvatar = {
      ...validSetting,
      user: { displayName: 'テスト', avatar: '/path/to/avatar.png' },
    }
    expect(validateSetting(withAvatar)).toBe(true)
  })

  it('completedAt が string の場合も受け入れる', () => {
    const completed = {
      ...validSetting,
      onboarding: { completedAt: '2026-04-18T00:00:00Z', wizardVersion: '0.1.0' },
    }
    expect(validateSetting(completed)).toBe(true)
  })

  it('null を拒否する', () => {
    expect(validateSetting(null)).toBe(false)
  })

  it('undefined を拒否する', () => {
    expect(validateSetting(undefined)).toBe(false)
  })

  it('不正な locale を拒否する', () => {
    expect(validateSetting({ ...validSetting, locale: 'fr' })).toBe(false)
  })

  // claudeMdGuidance is optional (claude-md-guidance-injection.md
  // §7.1). The schema is type-only here; the route handler additionally
  // strips the server-managed `lastInjectedAt` from request bodies so
  // a crafted PUT cannot persist a forged audit timestamp.

  it('accepts a setting without claudeMdGuidance (defaults apply)', () => {
    expect(validateSetting({ ...validSetting })).toBe(true)
  })

  it('accepts claudeMdGuidance with disabled boolean only', () => {
    const withFlag = {
      ...validSetting,
      claudeMdGuidance: { disabled: true },
    }
    expect(validateSetting(withFlag)).toBe(true)
  })

  it('accepts claudeMdGuidance with lastInjectedAt string', () => {
    const withTimestamp = {
      ...validSetting,
      claudeMdGuidance: { lastInjectedAt: '2026-05-10T03:14:25.123Z' },
    }
    expect(validateSetting(withTimestamp)).toBe(true)
  })

  it('rejects claudeMdGuidance with non-boolean disabled', () => {
    const bad = {
      ...validSetting,
      claudeMdGuidance: { disabled: 'yes' },
    }
    expect(validateSetting(bad)).toBe(false)
  })

  it('rejects claudeMdGuidance with non-string lastInjectedAt (e.g. number)', () => {
    const bad = {
      ...validSetting,
      claudeMdGuidance: { lastInjectedAt: 1234567890 },
    }
    expect(validateSetting(bad)).toBe(false)
  })

  it('rejects claudeMdGuidance set to null', () => {
    const bad = {
      ...validSetting,
      claudeMdGuidance: null,
    }
    expect(validateSetting(bad)).toBe(false)
  })

  // CodeX attempt 11 — defense-in-depth: a persisted dismiss snapshot
  // must capture a non-fail-closed check result. Otherwise an
  // on-disk edit can silence "unreadable settings" warnings.
  it('rejects claudeCodeSettingsWarning whose dismissedResult.reason is not "ok"', () => {
    const bad = {
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
    }
    expect(validateSetting(bad)).toBe(false)
  })

  it('accepts claudeCodeSettingsWarning with reason="ok"', () => {
    const good = {
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
    }
    expect(validateSetting(good)).toBe(true)
  })
})
