/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Verify that the i18n module reads its initial locale from
 * localStorage at module evaluation, and that `setLocale()` writes
 * the value back. This is what makes module-level `t(...)` callers —
 * `App.tsx` `menuEntries`, `RecipesPage.tsx` `TABS` — pick up the
 * locale the user chose on the previous load (typically during
 * onboarding) without needing each constant to be moved inside a
 * component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'kb.locale'

interface TestStorage {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

function makeMemoryLocalStorage(seed: Record<string, string> = {}): TestStorage {
  const store: Record<string, string> = { ...seed }
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  // Tear down the synthetic window so other suites can re-stub it.
  delete (globalThis as Record<string, unknown>).window
})

describe('i18n locale persistence', () => {
  it('defaults to en when nothing is persisted (OSS fallback)', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage(),
    }
    const i18n = await import('../../src/renderer/i18n/index')
    expect(i18n.getLocale()).toBe('en')
    // Sanity: the catalog actually returns English copy.
    expect(i18n.t('error.boundary.title')).toBe('KovitoBoard could not be displayed')
  })

  it('restores ja when localStorage holds ja', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage({ [STORAGE_KEY]: 'ja' }),
    }
    const i18n = await import('../../src/renderer/i18n/index')
    expect(i18n.getLocale()).toBe('ja')
    expect(i18n.t('error.boundary.title')).toBe('KovitoBoard を表示できませんでした')
  })

  it('restores en when localStorage holds en', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage({ [STORAGE_KEY]: 'en' }),
    }
    const i18n = await import('../../src/renderer/i18n/index')
    expect(i18n.getLocale()).toBe('en')
    expect(i18n.t('error.boundary.title')).toBe('KovitoBoard could not be displayed')
  })

  it('falls back to en for an unrecognized stored value', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage({ [STORAGE_KEY]: 'fr' }),
    }
    const i18n = await import('../../src/renderer/i18n/index')
    expect(i18n.getLocale()).toBe('en')
  })

  it('falls back to en when localStorage throws on read', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError')
        },
        setItem: () => {
          /* unused in this case */
        },
        removeItem: () => {
          /* unused */
        },
      },
    }
    const i18n = await import('../../src/renderer/i18n/index')
    expect(i18n.getLocale()).toBe('en')
  })

  it('persists the locale via setLocale so the next load can recover it', async () => {
    const store = makeMemoryLocalStorage()
    ;(globalThis as Record<string, unknown>).window = { localStorage: store }
    const i18n = await import('../../src/renderer/i18n/index')

    // No persisted value yet — picks up the OSS fallback.
    expect(i18n.getLocale()).toBe('en')
    i18n.setLocale('ja')
    expect(i18n.getLocale()).toBe('ja')
    expect(store.getItem(STORAGE_KEY)).toBe('ja')

    // Re-import in a fresh module cache to simulate a page reload —
    // the seeded-via-setLocale value should survive.
    vi.resetModules()
    const i18n2 = await import('../../src/renderer/i18n/index')
    expect(i18n2.getLocale()).toBe('ja')
  })

  it('still flips the in-memory locale even when persistence throws', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => {
          /* unused */
        },
      },
    }
    const i18n = await import('../../src/renderer/i18n/index')
    expect(i18n.getLocale()).toBe('en')
    i18n.setLocale('ja') // should not throw
    expect(i18n.getLocale()).toBe('ja')
  })
})
