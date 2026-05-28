/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Work Roots page — wraps `SettingsWorkRoots` with the page-level
 * chrome (full-height scroll container + horizontal padding) that
 * the standalone `/work-roots` route needs.
 *
 * v0.2.1 BL-2026-167 / judgement doc v1.1 §2.4 #4-5: the work-roots
 * surface itself moved into the Settings modal's `workRoots` tab,
 * but the `/work-roots` route is preserved so deep-links and
 * existing e2e specs targeting it keep working. The shared
 * `SettingsWorkRoots` component is intentionally chrome-free (it
 * mounts inside the modal's own scroll container), so this page
 * supplies the height + scroll container + padding that the
 * canonical full-page rendering expects. The default export is
 * preserved so `App.tsx`'s route element does not need to change.
 */
import { SettingsWorkRoots } from '../components/SettingsWorkRoots'

export default function WorkRootsPage() {
  return (
    <div className="flex flex-col h-full overflow-y-auto bg-[var(--bg-primary)] px-6 py-8">
      <SettingsWorkRoots />
    </div>
  )
}
