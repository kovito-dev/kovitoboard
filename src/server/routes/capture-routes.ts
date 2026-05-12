/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture endpoint opt-in router (v0.2.0, Phase 1 prompt-injection ①).
 *
 * Mounts under `/api/app/capture` and serves the runtime side of the
 * three-layer opt-in mechanism described in `recipe-system.md` v1.4
 * §6.10 / `http-api-contract.md` v1.3 §10.6 / `app-directory-
 * extension.md` v1.2 §10.5.2:
 *
 *   - layer 1 (declaration): the recipe's `recipe.yaml` lists the
 *     capture kinds it wants under `capture.requires`. The parser
 *     refuses values outside the closed `CaptureKind` enum.
 *   - layer 2 (consent):     the install-warning dialog records the
 *     subset the user agreed to as `approvedCaptures` on the
 *     manifest.
 *   - layer 3 (runtime):     this router verifies (active recipe →
 *     declaration → consent) on every capture call.
 *
 * Grandfather manifests (installed before the v0.2.0 fields existed)
 * migrate to `approvedCaptures: []` + `trustLevel: 'unknown'`, so
 * their capture calls always land on `CaptureNotApproved`. The
 * accompanying trust-marker UI handoff surfaces the cause to the
 * user.
 *
 * The router writes one `_capture-audit.log` entry per request — both
 * accepts and refuses — so operators can correlate prompt-injection
 * defence triggers with the upstream attack pattern.
 *
 * @see docs/design/handoffs/v02x-phase1-capture-optin-implementation-request.md
 * @stable v0.2.0
 */
import { Router } from 'express'
import type { Logger } from 'pino'
import { isValidCaptureKind } from '../recipe/apiTypes.js'
import type { CaptureKind, RecipeManifest } from '../recipe/apiTypes.js'
import { writeCaptureAuditLog } from '../auditLogger.js'
import { MAX_APP_ID_LENGTH } from '../../shared/security-limits.js'

/**
 * Minimal manifest-store contract this router depends on. Kept
 * narrower than the real `RecipeManifestStore` so unit tests can
 * inject a stub without rebuilding the whole class.
 */
export interface CaptureManifestLookup {
  get(appId: string): RecipeManifest | null
}

export interface CreateCaptureRouterOptions {
  manifestStore: CaptureManifestLookup
  projectRoot: string
  logger: Logger
}

/** Same shape as `markInstalledValidator.APP_ID_PATTERN`. */
const APP_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$`,
)

/**
 * Build the `/api/app/capture` router.
 *
 * Each `/api/app/capture/<kind>` endpoint runs the same 5-step
 * verification flow from `http-api-contract.md` §10.6.3. The route
 * does not execute the actual capture work today (the a11y snapshot
 * and exposeContext store live in the renderer); it gates the
 * gateway path so the v0.3.0 server-side capture surface can plug
 * in without revisiting the opt-in mechanism. Returning 204 on the
 * success path keeps the contract honest without committing to a
 * response shape we may want to change in v0.3.0.
 */
export function createCaptureRouter(opts: CreateCaptureRouterOptions): Router {
  const router = Router()
  const { manifestStore, projectRoot, logger } = opts

  router.post('/:kind', (req, res) => {
    const kindParam = req.params.kind
    // The kind path segment is the first thing we look at: a typo
    // here lets us fail before reading the body, and the closed enum
    // matches the on-disk schema so an unknown kind is always a
    // CaptureNotDeclared response.
    if (!isValidCaptureKind(kindParam)) {
      res.status(403).json({
        error: 'CaptureNotDeclared',
        message: `Capture '${kindParam}' is not a known capture kind.`,
        details: {
          // Echoing the path segment back keeps error messages
          // useful for recipe authors; we cap it to MAX_APP_ID_LENGTH
          // so a hostile caller cannot blow up the response body.
          kind: kindParam.slice(0, 64),
          remediation:
            'Use one of the kinds declared by the v0.2.x capture surface ' +
            '(a11y, exposed-context).',
        },
      })
      return
    }
    const kind: CaptureKind = kindParam

    const body = (req.body ?? {}) as Record<string, unknown>
    const rawAppId = body.appId
    if (typeof rawAppId !== 'string' || !APP_ID_PATTERN.test(rawAppId)) {
      // Without a resolvable appId we cannot identify the active
      // recipe, so we fall back to NoActiveRecipe. The 403 envelope
      // mirrors http-api-contract.md §10.6.4.
      res.status(403).json({
        error: 'NoActiveRecipe',
        message:
          'Capture call must include the active recipe appId in the body ' +
          'so the server can resolve the manifest. ' +
          `Expected appId to match /^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$/.`,
        details: {
          kind,
          remediation:
            'Use window.kb.capture.<kind>() from a mounted recipe page so ' +
            'the bridge forwards the active appId automatically.',
        },
      })
      // No audit-log write here: with no validated appId we have no
      // directory to write into and inventing a placeholder would
      // dilute the audit trail. The central logger picks up the
      // attempt below.
      logger.info({ kind }, 'capture: refused (no resolvable appId)')
      return
    }
    const appId = rawAppId

    const manifest = manifestStore.get(appId)
    if (!manifest) {
      // The appId looked syntactically valid but no manifest exists.
      // This is the most common path for stale tabs left over from
      // uninstalled apps and for callers that forge an arbitrary
      // appId. Treat it like the "no active recipe" case from the
      // caller's perspective.
      res.status(403).json({
        error: 'NoActiveRecipe',
        message: `No installed recipe matches appId "${appId}".`,
        details: {
          kind,
          appId,
          remediation:
            'Re-install the recipe (KovitoHub or developer sideload from v0.3.0) ' +
            'or reload the page so the renderer picks up the active manifest.',
        },
      })
      logger.info({ kind, appId }, 'capture: refused (no matching manifest)')
      // Same rationale as above — without a successfully-resolved
      // app data root we skip the audit log file write.
      return
    }

    // Manifest resolved; trustLevel is always available because the
    // grandfather migration backfills 'unknown' on load.
    const trustLevel = manifest.trustLevel

    // Step 3: declaration check. recipeManifestStore writes the
    // recipe-side `capture.requires` into manifest.approvedCaptures
    // implicitly — but it intentionally does NOT persist the recipe's
    // raw `capture.requires`. That keeps the manifest's authority
    // surface = "what the user agreed to". Therefore we read the
    // declaration from approvedCaptures alone: anything not in the
    // approved set is treated as either undeclared (mark below) or
    // unapproved.
    //
    // The wire spec distinguishes the two so an upstream attacker who
    // never showed the user a dialog (CaptureNotDeclared) can be told
    // apart from a user who declined the dialog
    // (CaptureNotApproved). Today the manifest cannot tell us which
    // case applies — both collapse to "not in approvedCaptures". To
    // preserve the distinction without storing the raw
    // `capture.requires`, we infer:
    //
    //   - When the manifest is a grandfather migration
    //     (trustLevel === 'unknown' + approvedCaptures === []) we
    //     return CaptureNotApproved with a remediation pointing at
    //     "re-install via KovitoHub". Spec §10.6.5 / §6.10.4 align.
    //   - Any other rejection we also surface as CaptureNotApproved.
    //
    // CaptureNotDeclared is reachable through the kindParam-validity
    // branch above (an unknown literal kind). Implementations that
    // grow the manifest to store the recipe's raw `capture.requires`
    // (planned for the v0.3.0 install handover) can move the
    // declaration check here without changing the wire contract.
    if (!manifest.approvedCaptures.includes(kind)) {
      const reason = 'CaptureNotApproved' as const
      res.status(403).json({
        error: reason,
        message:
          `Capture '${kind}' is not approved for this recipe (recipeId: ${manifest.recipeId}).`,
        details: {
          kind,
          recipeId: manifest.recipeId,
          appId,
          trustLevel,
          remediation:
            trustLevel === 'unknown'
              ? 'Grandfather recipe (v0.1.x/v0.2.0): capture not configured. ' +
                'Re-install via KovitoHub (v0.3.0) to enable capture, or grant ' +
                'approval via the install warning dialog when the install flow returns.'
              : 'Re-install via KovitoHub (v0.3.0) to enable capture, or grant ' +
                'approval via the install warning dialog.',
        },
      })
      writeCaptureAuditLog(
        {
          timestamp: new Date().toISOString(),
          appId,
          recipeId: manifest.recipeId,
          kind,
          trustLevel,
          result: 'rejected',
          reason,
        },
        projectRoot,
      )
      logger.info(
        { kind, appId, recipeId: manifest.recipeId, trustLevel, reason },
        'capture: refused',
      )
      return
    }

    // All gates passed. v0.2.x stops here because the capture
    // execution side (a11y snapshot, exposed-context reader) still
    // lives in the renderer; the server simply confirms that the
    // caller would have been allowed through. 204 mirrors that
    // contract — there is no body to send back.
    writeCaptureAuditLog(
      {
        timestamp: new Date().toISOString(),
        appId,
        recipeId: manifest.recipeId,
        kind,
        trustLevel,
        result: 'success',
      },
      projectRoot,
    )
    logger.info(
      { kind, appId, recipeId: manifest.recipeId, trustLevel },
      'capture: approved',
    )
    res.status(204).end()
  })

  return router
}
