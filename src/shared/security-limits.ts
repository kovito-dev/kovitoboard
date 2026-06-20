/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Security limits — DoS resistance ceilings for external inputs.
 *
 * Single source of truth (SSOT) for boundary values referenced by
 * recipe-parser entry validation, HTTP body limits, WebSocket
 * maxPayload, and related guards. The Markdown spec at
 * `docs/specs/security-limits.md` (kovitoboard-dev) v1.1 §5 owns
 * the numeric contract; changes to either side must land in the
 * same PR (kb-architect for the spec, developer for this file).
 *
 * v0.2.x scope: L-R1..L-R9 (Recipe Parser DoS) plus L-H3 (WebSocket
 * maxPayload) ship via this module. The remaining L-H / L-F / L-S / L-M
 * categories will land alongside their consuming module changes.
 */

// --- L-H: HTTP / WebSocket transport limits (spec §5) ---

/**
 * L-H3: max byte size of a single inbound WebSocket message. SSOT for
 * the `ws` library `maxPayload` on the shared `/api/ws` server (renderer
 * + extension). 1 MiB covers every use (trust prompt / handler dispatch
 * / log streaming / ext shared-chat); frames above it are rejected at
 * the protocol layer with close code 1009.
 */
export const WS_MESSAGE_LIMIT = 1_048_576 // 1 MiB

// --- L-R: Recipe Parser limits (spec §5.1) ---

/** L-R1: max raw `recipe.yaml` text size in bytes. */
export const MAX_RECIPE_YAML_BYTES = 1_048_576 // 1 MiB

/** L-R2: max combined recipe content size (yaml + artifacts) in bytes. */
export const MAX_RECIPE_TOTAL_BYTES = 10_485_760 // 10 MiB

/** L-R3: max number of artifact entries declared by a recipe. */
export const MAX_RECIPE_ARTIFACTS = 100

/** L-R4: max byte size of a single artifact file. */
export const MAX_ARTIFACT_FILE_BYTES = 2_097_152 // 2 MiB

/** L-R5: max character length of `recipeId`. */
export const MAX_RECIPE_ID_LENGTH = 64

/** L-R6: max character length of `appId`. */
export const MAX_APP_ID_LENGTH = 64

/** L-R7: max character length of `recipe.metadata.name`. */
export const MAX_RECIPE_NAME_LENGTH = 128

/** L-R8: max byte size of `recipe.instruction` body. */
export const MAX_INSTRUCTION_BYTES = 65_536 // 64 KiB

/** L-R9: max number of permission entries declared by `recipe.api.scopes`. */
export const MAX_PERMISSION_ENTRIES = 256
