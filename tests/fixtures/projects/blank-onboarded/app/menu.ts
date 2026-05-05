/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// L1 fixture ext app — present in `blank-onboarded` so spec files that
// rely on the AmbientSidebar (which after DEC-024 #3 §F7 only mounts
// on /ext/<appId>) have a stable host route. The shape below matches
// the menu-extractor regex (id/label/icon/component, single-quoted).
// AppMenuEntry type is intentionally not imported because the relative
// path would point outside the fixture project at parse time.
export const menuEntries = [
  {
    id: 'l1-fixture-app',
    label: 'L1 Fixture App',
    icon: 'content',
    component: () => import('./l1-fixture-app/pages/L1FixturePage'),
  },
]
