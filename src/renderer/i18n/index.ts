/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import ja, { type MessageKey } from './ja'
import en from './en'

type Locale = 'ja' | 'en'

const catalogs: Record<Locale, Record<MessageKey, string>> = { ja, en }

const STORAGE_KEY = 'kb.locale'
const FALLBACK_LOCALE: Locale = 'en'

/**
 * Read the persisted locale (set by `setLocale` on a previous page
 * load — typically during onboarding via `StepWelcome`). Defaults to
 * `en` when nothing is stored, when the value is unrecognized, or
 * when localStorage is unavailable (SSR / privacy mode).
 *
 * `en` is the OSS fallback: KovitoBoard ships as a public OSS project,
 * and a brand-new visitor whose preference has not yet been recorded
 * (incognito mode, cleared storage, first paint of the onboarding
 * wizard before its `setLocale` runs) should land on the international
 * default rather than on Japanese copy.
 *
 * Reading at module load (rather than via a runtime fetch) is what
 * lets module-level `t(...)` callers — e.g. `App.tsx` `menuEntries`
 * and `RecipesPage.tsx` `TABS` — pick up the correct catalog without
 * needing each constant to be moved inside the component.
 */
function readPersistedLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'ja' || stored === 'en') return stored
  } catch {
    /* localStorage unavailable */
  }
  return FALLBACK_LOCALE
}

/**
 * Persist the locale so the next page load can recover it before any
 * module-level `t(...)` call evaluates. Failures are intentionally
 * swallowed: the locale is still applied to the live catalog via
 * `currentLocale`, so the running session sees the right copy even if
 * the persistence step fails.
 */
function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    /* localStorage unavailable */
  }
}

let currentLocale: Locale = readPersistedLocale()

/** Set the current locale and persist it for subsequent loads. */
export function setLocale(locale: Locale): void {
  currentLocale = locale
  persistLocale(locale)
}

/** Get the current locale */
export function getLocale(): Locale {
  return currentLocale
}

/**
 * Retrieve a localized string by message key.
 * Placeholders ({key}) can be substituted via the params argument.
 *
 * Fallback chain when a catalog or key is missing:
 *   1. Active catalog (`currentLocale`)
 *   2. English catalog (the OSS fallback, see `FALLBACK_LOCALE`)
 *   3. The raw key (last-resort: surfaces the lookup miss instead of
 *      silently rendering an empty string).
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const catalog = catalogs[currentLocale] || catalogs[FALLBACK_LOCALE]
  let message = catalog[key] ?? en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      message = message.replace(`{${k}}`, String(v))
    }
  }
  return message
}

export type { MessageKey, Locale }
