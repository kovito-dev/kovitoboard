/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App extension API router
 *
 * GET /api/app/menu-entries — Return the user-defined menu entries
 *                              parsed from `app/menu.ts`. Empty array
 *                              when the file is absent.
 *
 * Background: the renderer used to load `app/menu.ts` directly via
 * Vite's `import.meta.glob`, but the dev server resolves the glob
 * exactly once when the parent module is first evaluated. Files
 * created later (e.g. by a recipe install) were therefore invisible
 * until the supervisor restarted the dev server. Routing through this
 * endpoint lets the renderer always see the latest contents.
 *
 * @stable v0.1.0
 */
import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import {
  readUserMenuEntries,
  type MenuEntryWithPage,
  type TrustLevelLookup,
} from '../services/menu-extractor'
import type { RecipeManifestStore } from '../recipeManifestStore'

/**
 * Build the app extension router.
 *
 * `manifestStore` is required so `/menu-entries` can attach the
 * active recipe's `trustLevel` to each entry. Without it the
 * renderer would have to call back for every entry it renders,
 * which would re-introduce the cross-request latency we already
 * pay once at supervisor startup.
 */
export function createAppRouter(
  fs: FileAccessLayer,
  manifestStore: RecipeManifestStore,
): Router {
  const router = Router()

  const trustLookup: TrustLevelLookup = (appId) =>
    manifestStore.get(appId)?.trustLevel ?? null

  router.get('/menu-entries', (_req, res) => {
    const entries: MenuEntryWithPage[] = readUserMenuEntries(fs, trustLookup)
    res.json(entries)
  })

  return router
}
