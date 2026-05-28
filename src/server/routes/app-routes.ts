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
  computeMenuOrderSnapshotFromEntries,
  readUserMenuEntries,
  type AppManifestLookup,
  type MenuEntryWithPage,
  type RecipeManifestLookup,
  type TrustLevelLookup,
} from '../services/menu-extractor'
import { getAppManifestPath, readAppManifest } from '../services/app-manifest'
import { resolveProjectRoot } from '../config'
import type { RecipeManifestStore } from '../recipeManifestStore'
import { serverLogger } from '../logger'
import { isRecipePageTrustLevel } from '../recipe/apiTypes'

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

  // Defence-in-depth: `recipeManifestStore.validateManifest` already
  // refuses to load a recipe manifest that carries the reserved
  // `'KB-trusted'` literal, but the wire boundary fails closed too —
  // any value that slips through (e.g. a manifest minted by an older
  // version, or an in-memory mutation after load) is coerced to
  // `null` by the `isRecipePageTrustLevel` guard before reaching the
  // extractor, whose `TrustLevelLookup` contract already statically
  // excludes the forbidden literal.
  const trustLookup: TrustLevelLookup = (appId) => {
    const value = manifestStore.get(appId)?.trustLevel
    if (isRecipePageTrustLevel(value)) return value
    if (value === 'KB-trusted') {
      serverLogger.warn(
        { appId },
        'Refusing to serve KB-trusted on a recipe-page menu entry; coercing to null. ' +
          'KB-trusted is reserved for KB-core surfaces — investigate the manifest source.',
      )
    }
    return null
  }

  // v0.2.1 Apps screen needs each menu row's `AppManifest`-sourced
  // UI fields (source badge / displayName / menuOrder / userMenuLabel).
  // We attach them on read so the renderer can render the Apps tab
  // without a second round-trip. `null` is returned for rows without
  // a matching manifest (legacy hand-edited `app/menu.ts`); the
  // renderer falls back to the bare `menu.ts` label in that case.
  const manifestLookup: AppManifestLookup = (appId) =>
    readAppManifest(fs, resolveProjectRoot(fs), appId)

  // Partial-residue fallback for the source badge + recipe
  // lineage. When the `AppManifest` file is present on disk but
  // unreadable (parse / schema-incoherent), the extractor
  // surfaces the persisted `RecipeManifest.source` +
  // `RecipeManifest.recipeId` so the Apps screen still shows the
  // badge AND the Disable action stays wired through
  // `POST /api/recipes/sample/:recipeId/disable`.
  //
  // The lookup deliberately does NOT fire when the AppManifest
  // file is entirely absent. Without that gate, a hand-edited
  // `app/menu.ts` row whose `appId` happens to collide with a
  // stale `recipes-installed/<appId>/manifest.json` would inherit
  // recipe lineage that does not belong to it -- and because
  // this PR now wires the Apps tab's Action menu to disable that
  // recipe scope, a collision would let the user disable the
  // wrong recipe. Honest "bundled-but-AppManifest-gone" rows are
  // therefore left without a Disable wiring in this iteration;
  // the next legitimate enable cycle re-creates the AppManifest
  // and the badge / Disable come back automatically. A
  // recipe-history.jsonl evidence join that distinguishes
  // "ever-installed-here" from "stale-residue collision" would
  // let us reopen the recovery path safely -- that is the
  // deferred scanner-pipeline follow-up tracked in the PR's
  // Out-of-Scope list (BL deferred to v0.2.2).
  const recipeManifestLookup: RecipeManifestLookup = (appId) => {
    const manifestPath = getAppManifestPath(resolveProjectRoot(fs), appId)
    if (!fs.existsSync(manifestPath)) {
      return null
    }
    return manifestStore.get(appId)
  }

  router.get('/menu-entries', (_req, res) => {
    const entries: MenuEntryWithPage[] = readUserMenuEntries(
      fs,
      trustLookup,
      manifestLookup,
      recipeManifestLookup,
    )
    // Surface the current menu-order snapshot in a response header
    // so the renderer can seed `snapshotVersionRef` before the user's
    // very first reorder lands. The spec pins the wire body to
    // `MenuEntryWithPage[]` (`http-api-contract.md` v1.7.1 §6.3.8.A
    // table), so we route the snapshot through a custom header
    // instead of reshaping the JSON payload (which would be a
    // wire-level break for any pre-v0.2.1 consumer of the endpoint).
    // The PUT side recomputes the snapshot from the live manifests
    // at write time (`apps-routes.ts computeMenuOrderSnapshot`); the
    // algorithms are pinned by `computeMenuOrderSnapshotFromEntries`
    // here so the renderer's seed matches the PUT-side comparison.
    res.setHeader(
      'X-Apps-Menu-Snapshot',
      computeMenuOrderSnapshotFromEntries(entries),
    )
    res.json(entries)
  })

  return router
}
