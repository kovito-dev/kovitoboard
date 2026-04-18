/**
 * setting-manager の単体テスト
 *
 * validateSetting: v1.1 スキーマ検証（project.path 必須）
 * readSetting: 1.0 → 1.1 マイグレーション
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
})
