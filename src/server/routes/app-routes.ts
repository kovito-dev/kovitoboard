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
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import {
  assignProvisionalMenuOrder,
  computeMenuOrderSnapshotFromEntries,
  readUserMenuEntries,
  type AppManifestLookup,
  type MenuEntryWithPage,
  type RecipeManifestLookup,
  type TrustLevelLookup,
} from '../services/menu-extractor'
import { getAppManifestPath, readAppManifest } from '../services/app-manifest'
import { resolveProjectRoot } from '../config'
import { isWithin } from '../pathResolver'
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

  // Defence-in-depth: resolve the per-row `app/<appId>` directory
  // through `realpath` and verify it stays inside
  // `<canonicalProjectRoot>/app` before reading any manifest
  // file. Without this gate, a crafted `app/<appId>` symlink
  // could redirect the manifest reads (`readAppManifest` +
  // `existsSync(getAppManifestPath(...))`) at a file outside the
  // project tree -- exposing arbitrary `manifest.json`-shaped
  // payloads as wire badge / displayName / recipe-lineage fields.
  // The write routes (`apps-routes.ts`) already run this boundary
  // check before mutating; the GET path now matches the same
  // contract.
  function withinAppBoundary(appId: string): boolean {
    const projectRoot = resolveProjectRoot(fs)
    try {
      const realProjectRoot = fs.realpathSync(projectRoot)
      const realAppDir = fs.realpathSync(join(projectRoot, 'app', appId))
      const appBoundary = join(realProjectRoot, 'app')
      return isWithin(realAppDir, appBoundary)
    } catch {
      // `realpathSync` failure (ENOENT for the per-app dir, broken
      // symlink, ELOOP, etc.) is treated as "not safe to read"
      // -- fail closed. Legitimate partial-residue states where
      // the on-disk `app/<appId>` exists still resolve cleanly;
      // truly absent rows just return `null` to the renderer
      // (which already handles that as "no manifest attached").
      return false
    }
  }

  // v0.2.1 Apps screen needs each menu row's `AppManifest`-sourced
  // UI fields (source badge / displayName / menuOrder / userMenuLabel).
  // We attach them on read so the renderer can render the Apps tab
  // without a second round-trip. `null` is returned for rows without
  // a matching manifest (legacy hand-edited `app/menu.ts`); the
  // renderer falls back to the bare `menu.ts` label in that case.
  const manifestLookup: AppManifestLookup = (appId) => {
    if (!withinAppBoundary(appId)) return null
    return readAppManifest(fs, resolveProjectRoot(fs), appId)
  }

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
    if (!withinAppBoundary(appId)) return null
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
    // Fail-closed: drop any entry whose canonical app directory
    // could not be verified inside `<projectRoot>/app`. The
    // boundary check inside `manifestLookup` / `recipeManifestLookup`
    // already returns `null` for those rows, but the row was
    // still flowing onto the wire as `manifestState === 'missing'`
    // -- and the Apps tab routes `'missing'` into the legacy
    // Remove path, which would let a user delete an anomalous /
    // symlinked subtree they should never have been offered as a
    // legacy row. Re-running the boundary check here and skipping
    // the failing rows keeps anomalies out of the wire entirely;
    // the renderer never sees them and cannot surface any action.
    const safeEntries = entries.filter((entry) =>
      withinAppBoundary(entry.id),
    )
    // Surface the current menu-order snapshot in a response header
    // so the renderer can seed `snapshotVersionRef` before the user's
    // very first reorder lands. The spec pins the wire body to
    // `MenuEntryWithPage[]` (`http-api-contract.md` v1.7.1 §6.3.8.A
    // table), so we route the snapshot through a custom header
    // instead of reshaping the JSON payload (which would be a
    // wire-level break for any pre-v0.2.1 consumer of the endpoint).
    // The PUT side recomputes the snapshot from the live manifests
    // at write time (`apps-routes.ts computeMenuOrderSnapshot`).
    // Compute the snapshot from the persisted-only `menuOrder`
    // values BEFORE applying the provisional scanner assignment
    // -- otherwise the GET snapshot would contain synthetic
    // indices while the PUT snapshot still sees `null` on the
    // unassigned manifests, producing a spurious 409
    // `MenuOrderSnapshotDrift` on the first reorder.
    res.setHeader(
      'X-Apps-Menu-Snapshot',
      computeMenuOrderSnapshotFromEntries(safeEntries),
    )
    // Apply the spec's transient provisional `menuOrder`
    // assignment AFTER snapshot computation so the wire payload
    // still has a stable sort key for the renderer's first paint
    // even when the persisted manifests carry `menuOrder: null`.
    assignProvisionalMenuOrder(safeEntries)
    res.json(safeEntries)
  })

  return router
}
