/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Renderer-side helpers for displaying recipe metadata.
 *
 * The bundled sample recipes ship Japanese-default `name` and
 * `description` fields with optional locale overrides under
 * `metadata.i18n[<locale>]`. The renderer picks the entry matching
 * the active UI locale and falls back to the top-level fields when
 * no override is declared, so unlocalised user recipes pass through
 * unchanged.
 */
import type { RecipeMetadata } from '../../shared/recipe-types'
import { getLocale } from '../i18n'

/**
 * Localised metadata fields. Loosened from `RecipeMetadata` so call
 * sites that work with summary types — e.g. `SampleRecipeInfo` from
 * `/api/recipes/sample`, which omits `recipeId` — can still pass
 * their `metadata` shape.
 */
type LocalisedMetadata = Pick<RecipeMetadata, 'name' | 'description'> &
  Partial<Pick<RecipeMetadata, 'i18n'>>

export function getRecipeName(metadata: LocalisedMetadata): string {
  const override = metadata.i18n?.[getLocale()]?.name
  return override && override.length > 0 ? override : metadata.name
}

export function getRecipeDescription(metadata: LocalisedMetadata): string {
  const override = metadata.i18n?.[getLocale()]?.description
  return override && override.length > 0 ? override : metadata.description
}
