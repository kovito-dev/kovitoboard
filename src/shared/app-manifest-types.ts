/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App manifest type definitions.
 *
 * App manifest = `app/<appId>/manifest.json` — identifies an installed
 * app and tracks its source (recipe-derived or user-creation) and
 * recipe lineage when applicable.
 *
 * The dispatcher does NOT read this file at runtime — it reads
 * `recipes-installed/<appId>/manifest.json` (a different manifest
 * file, see `RecipeManifest` in `src/server/recipe/apiTypes.ts`).
 * The app manifest is used by:
 *   - The recipe sample page, to identify "currently installed" apps
 *     by `source.recipeId` for the badge display (alongside
 *     `recipe-history.json`).
 *   - The agent, during deletion, to know what to remove.
 *   - The reinstall flow, for same-name conflict detection.
 *
 * The app manifest's `appId` is the KB-local identifier — the same
 * one used for the menu entry, the `app/<appId>/` directory, the
 * `app/data/<appId>/` data root, and the `window.kb.call` dispatcher
 * key. The recipe's own `recipeId` (the immutable id chosen by the
 * recipe author) is captured under `source.recipeId` so multiple
 * apps can be derived from the same recipe.
 *
 * @stable v0.1.0
 * @see docs/specs/v0.1.0-app-id-and-manifest.md §3.2
 * @see DEC-024 D-4-a, recipe-system.md v2.0 § 13-3
 */

/**
 * Source information for an installed app — discriminated by `type`.
 *
 * - `'recipe'`: the app was installed from a recipe (sample / import
 *   / URL). Carries the recipe's identity so the UI can show "this
 *   was installed from recipe X" and re-installs / updates can match
 *   the same recipe lineage.
 * - `'user-creation'`: the app was created via the AppCreateModal
 *   (no recipe; the agent generated artifacts directly). The agent
 *   id is preserved so we can later attribute "who created this
 *   app" if the UI needs that affordance.
 */
export type AppSourceInfo =
  | {
      type: 'recipe'
      /**
       * The `recipeId` from `recipe.yaml` (DEC-024 D-8). Stable across
       * recipe versions and may take forms like
       * `"kovito-dev/document-viewer"` or a hash literal.
       */
      recipeId: string
      /** The `version` from `recipe.yaml` at install time. */
      recipeVersion: string
      /** Where the recipe was sourced from. */
      recipeSource: 'sample' | 'import' | 'url'
    }
  | {
      type: 'user-creation'
      /**
       * The agent id selected in the `AppCreateModal` agent picker.
       * Recorded so future tooling can trace "which agent created
       * this app".
       */
      createdViaAgent: string
    }

/**
 * The full app manifest persisted at `app/<appId>/manifest.json`.
 *
 * Required for every installed app — the install endpoint writes
 * this synchronously after the agent's artifacts have been delivered
 * (see `app-manifest.ts` helper). A missing manifest signals a
 * half-installed state that the uninstall / reinstall flows treat
 * as needing repair.
 */
export interface AppManifest {
  /**
   * The KB-local app identifier. Required, and unique within a
   * KovitoBoard project (see
   * `POST /api/apps/check-id-availability`). Drives the menu key,
   * the `app/<appId>/` directory layout, the `app/data/<appId>/`
   * data root, and the `window.kb.call` dispatcher key.
   */
  appId: string

  /**
   * Display name shown in the UI. May differ from `appId` (e.g. a
   * Japanese label for an English-id app).
   */
  displayName: string

  /** ISO 8601 timestamp of when the app was created. */
  createdAt: string

  /**
   * KovitoBoard version string at the time of creation (e.g.
   * `"0.1.0"`). Captured so future upgrade tools can detect
   * compatibility breaks.
   */
  kovitoboardVersion: string

  /** Source information — recipe-derived or user-creation. */
  source: AppSourceInfo
}
