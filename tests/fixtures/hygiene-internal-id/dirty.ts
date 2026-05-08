/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Intentionally dirty fixture for the hygiene internal-id detector.
// This file is excluded from the actual scan via INTERNAL_ID_EXCLUDE_PREFIXES;
// the unit tests load it directly to verify pattern matching.

// P-1 DEC ID match
// See DEC-018 for the rationale.

// P-2 BL ID match
// Tracked under BL-2026-099.

// P-7 internal question ID matches: Q4, SS-3, AA-7

export const dirty = 'placeholder'
