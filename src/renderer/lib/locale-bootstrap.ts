/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Bootstrap the renderer locale from the server-side settings file
 * (`.kovitoboard/setting.json`) before the App module is imported.
 *
 * The renderer's i18n module reads its initial locale from
 * `localStorage['kb.locale']` at module evaluation, which works fine
 * for users who completed onboarding after locale persistence landed
 * (commit `db023ee`). However, users in any of the following
 * situations end up with an empty `localStorage` even though
 * `setting.json` records their chosen locale:
 *
 *   - Onboarded before `db023ee`
 *   - Cleared site data / privacy mode
 *   - Opened the app from a different browser
 *
 * For those users, the renderer would silently fall back to the OSS
 * default (`en`, see `i18n/index.ts` `FALLBACK_LOCALE`) and render
 * the entire UI in English even when the server has `locale: 'ja'`
 * persisted.
 *
 * This module bridges that gap: it fetches `/api/config/setting`, and
 * if the response carries a recognized `locale`, it calls
 * `setLocale()` (which writes the value back to `localStorage`).
 * Calling this before `import('./App')` ensures that App's
 * module-level `t(...)` constants — `menuEntries`, RecipesPage
 * `TABS`, SettingsModal `TABS` — pick up the correct catalog on the
 * very first render.
 *
 * The fetch is best-effort: any failure (network error, malformed
 * JSON, missing setting file) leaves the renderer on whatever the
 * i18n module already resolved from `localStorage` / the OSS
 * fallback. We never block the UI on this call.
 */
import { setLocale } from '../i18n'
import type { Locale } from '../i18n'

/**
 * The narrow shape of `/api/config/setting` we actually consume here.
 * We deliberately do not import `KovitoboardSetting` from
 * `shared/setting-types` because (a) the server may return a payload
 * with extra fields we do not care about, and (b) we want this
 * bootstrap to be resilient to schema drift — if `locale` is missing
 * or a value we do not recognize, we simply do nothing.
 */
interface SettingResponseShape {
  locale?: unknown
}

function isLocale(value: unknown): value is Locale {
  return value === 'ja' || value === 'en'
}

/**
 * Fetch the server-side settings and, if a recognized `locale` is
 * present, apply it via `setLocale()`. Resolves on completion
 * (success or graceful failure); never throws.
 *
 * @param fetchImpl  Injectable fetch (defaults to global `fetch`).
 *                   Lets unit tests stub the network call without
 *                   touching `globalThis.fetch`.
 */
export async function bootstrapLocaleFromSetting(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl('/api/config/setting')
  } catch {
    // Network error — fall through to localStorage / OSS fallback.
    return
  }

  // 404 / 500 / etc. — setting.json absent or unreadable. Do not
  // override the renderer's already-resolved locale.
  if (!response.ok) return

  let data: SettingResponseShape | null
  try {
    data = (await response.json()) as SettingResponseShape | null
  } catch {
    return
  }

  if (data == null) return

  const locale = data.locale
  if (!isLocale(locale)) return

  setLocale(locale)
}
