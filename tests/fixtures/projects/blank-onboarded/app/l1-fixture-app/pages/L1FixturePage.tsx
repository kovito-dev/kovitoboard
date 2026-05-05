/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// Dummy ext-app page baked into the L1 `blank-onboarded` fixture so
// the AmbientSidebar (which DEC-024 #3 §F7 limits to /ext/<appId>) has
// a stable mount route in L1 specs. The @vitejs/plugin-react preset
// auto-injects the JSX runtime, so no explicit React import is needed.
export default function L1FixturePage() {
  return <div data-testid="l1-fixture-page">L1 fixture page</div>
}
