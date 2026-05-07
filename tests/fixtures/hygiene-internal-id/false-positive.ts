/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Strings that look like the broad commit-msg regex would match but the
// hygiene detector's narrowed P-7 must NOT match these:
//   HTTP-2, RFC-1234, IETF-1234, ABC-9
//
// And the placeholder forms used in CONTRIBUTING.md examples must not match
// because P-1 / P-2 require digits:
//   DEC-xxx, BL-xxxx

export const protocols = ['HTTP-2', 'RFC-1234', 'IETF-1234', 'ABC-9']
export const placeholders = ['DEC-xxx', 'BL-xxxx']
