/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Verify that `bootstrapLocaleFromSetting()` correctly bridges the
 * server-side `setting.json` to the renderer's i18n module. This is
 * the missing sync that caused users with `setting.locale: 'ja'` but
 * empty `localStorage['kb.locale']` to render the entire UI in
 * English after the OSS-fallback flip from `ja` to `en` (commit
 * `6fb85c2`).
 *
 * The bootstrap must:
 *   - Apply `setLocale(locale)` when the server returns a recognized
 *     locale.
 *   - Stay silent (no `setLocale` call) when the server returns no
 *     locale, an unknown value, a non-OK response, malformed JSON, or
 *     a network error.
 *
 * Tests use `vi.resetModules()` between cases so a fresh i18n module
 * is observed each time, and a fake `window.localStorage` so
 * `setLocale()` (which calls `localStorage.setItem`) does not blow
 * up under the Vitest jsdom-less environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/**
 * Build a minimal stub for `fetch` that returns a single canned
 * response. Keeps each test's intent isolated to one network outcome.
 */
function makeFetch(response: Partial<Response> | (() => Promise<never>)): typeof fetch {
  if (typeof response === 'function') {
    return response as unknown as typeof fetch
  }
  return (async () => response as Response) as unknown as typeof fetch
}

beforeEach(() => {
  vi.resetModules()
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: makeMemoryLocalStorage(),
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('bootstrapLocaleFromSetting', () => {
  it("applies setLocale('ja') when setting.json has locale: 'ja'", async () => {
    const fetchStub = makeFetch({
      ok: true,
      json: async () => ({ locale: 'ja' }),
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    // Empty localStorage → renderer initial = OSS fallback (en).
    expect(i18n.getLocale()).toBe('en')

    await bootstrapLocaleFromSetting(fetchStub)

    expect(i18n.getLocale()).toBe('ja')
    // setLocale persists to localStorage so the next reload skips the
    // bootstrap-and-flip flicker.
    expect(
      (globalThis as Record<string, { localStorage: TestStorage }>).window
        .localStorage.getItem('kb.locale'),
    ).toBe('ja')
  })

  it("applies setLocale('en') when setting.json has locale: 'en'", async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage({ 'kb.locale': 'ja' }),
    }
    const fetchStub = makeFetch({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    expect(i18n.getLocale()).toBe('ja')
    await bootstrapLocaleFromSetting(fetchStub)
    // Server-side setting wins over previously-cached localStorage.
    expect(i18n.getLocale()).toBe('en')
  })

  it('does nothing when the response is not OK (setting.json missing)', async () => {
    const fetchStub = makeFetch({
      ok: false,
      status: 404,
      json: async () => null,
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    expect(i18n.getLocale()).toBe('en')
    await bootstrapLocaleFromSetting(fetchStub)
    expect(i18n.getLocale()).toBe('en')
  })

  it('does nothing when the body is null (setting.json absent on backend)', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage({ 'kb.locale': 'ja' }),
    }
    const fetchStub = makeFetch({
      ok: true,
      json: async () => null,
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    expect(i18n.getLocale()).toBe('ja')
    await bootstrapLocaleFromSetting(fetchStub)
    // localStorage value is preserved.
    expect(i18n.getLocale()).toBe('ja')
  })

  it('does nothing when the locale field is missing from the payload', async () => {
    const fetchStub = makeFetch({
      ok: true,
      json: async () => ({ user: { displayName: 'Tester' } }),
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    await bootstrapLocaleFromSetting(fetchStub)
    expect(i18n.getLocale()).toBe('en')
  })

  it('does nothing when the locale value is not a recognized code', async () => {
    const fetchStub = makeFetch({
      ok: true,
      json: async () => ({ locale: 'fr' }),
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    await bootstrapLocaleFromSetting(fetchStub)
    expect(i18n.getLocale()).toBe('en')
  })

  it('swallows network errors and leaves the renderer locale untouched', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: makeMemoryLocalStorage({ 'kb.locale': 'ja' }),
    }
    const fetchStub = makeFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    expect(i18n.getLocale()).toBe('ja')
    await expect(bootstrapLocaleFromSetting(fetchStub)).resolves.toBeUndefined()
    expect(i18n.getLocale()).toBe('ja')
  })

  it('swallows malformed JSON without flipping the locale', async () => {
    const fetchStub = makeFetch({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    })
    const { bootstrapLocaleFromSetting } = await import(
      '../../src/renderer/lib/locale-bootstrap'
    )
    const i18n = await import('../../src/renderer/i18n/index')

    await expect(bootstrapLocaleFromSetting(fetchStub)).resolves.toBeUndefined()
    expect(i18n.getLocale()).toBe('en')
  })
})
