/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Shared L1 helper for driving the active locale in i18n specs.
 *
 * The server resolves the active locale from `.kovitoboard/setting.json`
 * (`readSetting(fs)?.locale`) on every request, and the renderer boots
 * its locale from the same value via `bootstrapLocaleFromSetting()`
 * before mounting. So a plain on-disk edit followed by a refetch /
 * reload is enough to switch locale — no API round-trip or server
 * restart needed. The per-test `.kovitoboard/` snapshot/restore in
 * `l1-per-test-setup` rolls the file back, keeping specs
 * order-independent.
 *
 * Extracted here so the nav-label and page-body i18n specs share one
 * encoding of the `setting.json` locale contract instead of drifting.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Locale = 'ja' | 'en'

/**
 * Overwrite `setting.json:locale` for the given project root, preserving
 * every other field. Must run before the request / navigation whose
 * locale it is meant to affect.
 */
export function setLocaleOnDisk(projectRoot: string, locale: Locale): void {
  const settingPath = join(projectRoot, '.kovitoboard', 'setting.json')
  const setting = JSON.parse(readFileSync(settingPath, 'utf-8')) as Record<
    string,
    unknown
  >
  setting.locale = locale
  writeFileSync(settingPath, JSON.stringify(setting, null, 2))
}
