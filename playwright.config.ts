/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// Root config re-exports L1 for backward compatibility.
// `playwright test` (without -c) runs the L1 suite.
export { default } from './playwright.config.l1'
