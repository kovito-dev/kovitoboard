/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Work Roots page — thin wrapper around `SettingsWorkRoots`.
 *
 * v0.2.1 BL-2026-167 / judgement doc v1.1 §2.4 #4-5: the work-roots
 * surface was moved into the Settings modal's `workRoots` tab. The
 * route is kept alive so deep-links / existing e2e specs targeting
 * `/work-roots` continue to render the same UI (no redirect, so
 * the URL bar still reads `/work-roots` after navigation). The
 * default export is preserved so `App.tsx`'s route element does
 * not need to change.
 */
import { SettingsWorkRoots } from '../components/SettingsWorkRoots'

export default function WorkRootsPage() {
  return <SettingsWorkRoots />
}
