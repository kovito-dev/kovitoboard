/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Clean fixture for the hygiene internal-id detector.
// Contains no internal IDs, agent tags, or question IDs.

export const clean = 'no internal references here'

// Function names that share characters with patterns but should NOT match.
export function inspectArtifacts(): void {
  // intentionally empty
}
