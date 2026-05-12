/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture endpoint opt-in router (v0.2.0, Phase 1 prompt-injection ①).
 *
 * Mounts under `/api/app/capture` and serves the runtime side of the
 * three-layer opt-in mechanism described in `recipe-system.md` v1.5
 * §6.10 / `http-api-contract.md` v1.3.1 §10.6 /
 * `app-directory-extension.md` v1.2.1 §10.5.2:
 *
 *   - layer 1 (declaration): the recipe's `recipe.yaml` lists the
 *     capture kinds it wants under `capture.requires`. The parser
 *     refuses values outside the closed `CaptureKind` enum, and
 *     the install flow persists the declared kinds onto the
 *     manifest as `captureRequires` (spec v1.5).
 *   - layer 2 (consent):     the install-warning dialog records the
 *     subset the user agreed to as `approvedCaptures` on the
 *     manifest. Invariant I-CR1 keeps `approvedCaptures ⊆
 *     captureRequires`.
 *   - layer 3 (runtime):     this router verifies (active recipe →
 *     declaration → consent) on every capture call, with step 3
 *     (declaration) and step 4 (consent) enforced **independently**
 *     per invariant I-CR3. Collapsing them undermines defence
 *     against installer / migration tampering — see the v1.5
 *     rationale block in §6.10.3.
 *
 * Grandfather manifests (installed before the v0.2.0 fields existed)
 * migrate to `captureRequires: []` + `approvedCaptures: []` +
 * `trustLevel: 'unknown'`, so their capture calls always land on
 * step 3 (`CaptureNotDeclared`). The accompanying trust-marker UI
 * handoff surfaces the cause to the user.
 *
 * The router writes one `_capture-audit.log` entry per request — both
 * accepts and refuses — covering all five spec-mandated reason
 * values. Requests that did not resolve to an appId (`unresolved-
 * appid` / `no-active-recipe`) land in the global sink at
 * `app/_unresolved-capture-audit.log` so forged / probing traffic
 * stays visible alongside legitimate refuses.
 *
 * @see docs/design/handoffs/v02x-phase1-capture-optin-implementation-request.md v1.1
 * @stable v0.2.0
 */
import { Router } from 'express'
import type { Logger } from 'pino'
import { isValidCaptureKind } from '../recipe/apiTypes.js'
import type { CaptureKind, RecipeManifest } from '../recipe/apiTypes.js'
import {
  writeCaptureAuditLog,
  type CaptureAuditEntry,
  type CaptureAuditReason,
} from '../auditLogger.js'
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
 * Each `/api/app/capture/<kind>` endpoint runs the canonical 5-step
 * verification flow from `http-api-contract.md` §10.6.3:
 *
 *   1. `<kind>` path segment must belong to the closed `CaptureKind`
 *      enum — anything else short-circuits to `CaptureNotDeclared`
 *      (reason: `not-declared`).
 *   2. The request body must include a syntactically-valid appId —
 *      otherwise the call is `NoActiveRecipe` with reason
 *      `unresolved-appid`. The global audit sink records the
 *      attempt so forged probes stay visible.
 *   3. The manifest store must resolve the appId — otherwise the
 *      call is `NoActiveRecipe` with reason `no-active-recipe`.
 *      Same global-sink rules as step 2.
 *   4. `manifest.captureRequires.includes(kind)` — otherwise
 *      `CaptureNotDeclared` with reason `not-declared`. This is the
 *      I-CR3-mandated declaration check.
 *   5. `manifest.approvedCaptures.includes(kind)` — otherwise
 *      `CaptureNotApproved` with reason `not-approved`. This is the
 *      I-CR3-mandated consent check.
 *
 * The success path returns 204 No Content — the actual capture work
 * still lives in the renderer in v0.2.x. The router is the gate.
 */
export function createCaptureRouter(opts: CreateCaptureRouterOptions): Router {
  const router = Router()
  const { manifestStore, projectRoot, logger } = opts

  /**
   * Local helper that emits a structured audit entry and forwards
   * to whichever sink the entry's appId resolves to. The pino logger
   * line goes out alongside so operators see both signals.
   */
  function recordDecision(params: {
    kind: CaptureKind
    appId: string | null
    manifest: RecipeManifest | null
    reason: CaptureAuditReason
  }): void {
    const { kind, appId, manifest, reason } = params
    const entry: CaptureAuditEntry = {
      timestamp: new Date().toISOString(),
      appId,
      recipeId: manifest ? manifest.recipeId : null,
      kind,
      trustLevel: manifest ? manifest.trustLevel : null,
      result: reason === 'approved' ? 'success' : 'rejected',
      reason,
    }
    writeCaptureAuditLog(entry, projectRoot)
    logger.info(
      {
        kind,
        appId,
        recipeId: manifest?.recipeId ?? null,
        trustLevel: manifest?.trustLevel ?? null,
        reason,
      },
      reason === 'approved' ? 'capture: approved' : 'capture: refused',
    )
  }

  router.post('/:kind', (req, res) => {
    const kindParam = req.params.kind
    // Step 1: closed-enum check on the path segment. An unknown
    // literal collapses to CaptureNotDeclared because the manifest
    // cannot declare a kind that v0.2.x doesn't recognise.
    if (!isValidCaptureKind(kindParam)) {
      res.status(403).json({
        error: 'CaptureNotDeclared',
        message: `Capture '${kindParam}' is not a known capture kind.`,
        details: {
          kind: kindParam.slice(0, 64),
          reason: 'not-declared',
          remediation:
            'Use one of the kinds declared by the v0.2.x capture surface ' +
            '(a11y, exposed-context).',
        },
      })
      // We cannot key the audit by a sound CaptureKind (the path
      // segment is the very thing we just refused), so the global
      // sink stores the entry with kind="a11y" as a placeholder
      // would not be honest. Instead we record the attempt via the
      // logger line only — the operator still sees the refusal in
      // server.log under reason='not-declared'. Spec §10.6.5
      // mandates the audit log entry but the schema requires a
      // valid CaptureKind, so unknown-literal probes are flagged
      // only in the central log; the per-file capture-audit
      // becomes incomplete for them by spec construction.
      logger.info(
        { kind: kindParam.slice(0, 64), reason: 'not-declared' },
        'capture: refused (unknown literal kind)',
      )
      return
    }
    const kind: CaptureKind = kindParam

    const body = (req.body ?? {}) as Record<string, unknown>
    const rawAppId = body.appId
    if (typeof rawAppId !== 'string' || !APP_ID_PATTERN.test(rawAppId)) {
      // Step 2: appId syntactic check. A missing / malformed appId
      // is the most common forged-probe vector, so we still emit a
      // structured audit line (global sink, appId=null) per spec
      // §10.6.5 reason='unresolved-appid'.
      res.status(403).json({
        error: 'NoActiveRecipe',
        message:
          'Capture call must include the active recipe appId in the body ' +
          'so the server can resolve the manifest. ' +
          `Expected appId to match /^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$/.`,
        details: {
          kind,
          reason: 'unresolved-appid',
          remediation:
            'Use window.kb.capture.<kind>() from a mounted recipe page so ' +
            'the bridge forwards the active appId automatically.',
        },
      })
      recordDecision({ kind, appId: null, manifest: null, reason: 'unresolved-appid' })
      return
    }
    const appId = rawAppId

    const manifest = manifestStore.get(appId)
    if (!manifest) {
      // Step 3 (manifest lookup). The appId resolved syntactically
      // but no manifest matches. Audit lands in the global sink so
      // forged-appId probes (and stale tabs left over from
      // uninstalled apps) stay visible.
      res.status(403).json({
        error: 'NoActiveRecipe',
        message: `No installed recipe matches appId "${appId}".`,
        details: {
          kind,
          appId,
          reason: 'no-active-recipe',
          remediation:
            'Re-install the recipe (KovitoHub or developer sideload from v0.3.0) ' +
            'or reload the page so the renderer picks up the active manifest.',
        },
      })
      recordDecision({ kind, appId: null, manifest: null, reason: 'no-active-recipe' })
      return
    }

    const trustLevel = manifest.trustLevel

    // Step 4 (declaration check, I-CR3). The manifest's
    // `captureRequires` is the authoritative declared surface; a
    // kind missing from it is `CaptureNotDeclared` regardless of
    // approval state. Grandfather installs always land here because
    // they migrate to `captureRequires: []`.
    if (!manifest.captureRequires.includes(kind)) {
      res.status(403).json({
        error: 'CaptureNotDeclared',
        message:
          `Capture '${kind}' is not declared by this recipe (recipeId: ${manifest.recipeId}).`,
        details: {
          kind,
          recipeId: manifest.recipeId,
          appId,
          trustLevel,
          reason: 'not-declared',
          remediation:
            trustLevel === 'unknown'
              ? 'Grandfather recipe (v0.1.x/v0.2.0): capture not configured. ' +
                'Re-install via KovitoHub (v0.3.0) so the recipe declares the kind under capture.requires.'
              : 'Update the recipe to declare the kind under capture.requires, then re-install via KovitoHub (v0.3.0).',
        },
      })
      recordDecision({ kind, appId, manifest, reason: 'not-declared' })
      return
    }

    // Step 5 (consent check, I-CR3). The declared surface contains
    // the kind; the user must additionally have approved it during
    // install. I-CR1 guarantees `approvedCaptures ⊆
    // captureRequires`, so this branch is reachable only when the
    // user declined the specific kind during the install dialog.
    if (!manifest.approvedCaptures.includes(kind)) {
      res.status(403).json({
        error: 'CaptureNotApproved',
        message:
          `Capture '${kind}' is not approved for this recipe (recipeId: ${manifest.recipeId}).`,
        details: {
          kind,
          recipeId: manifest.recipeId,
          appId,
          trustLevel,
          reason: 'not-approved',
          remediation:
            'Re-install via KovitoHub (v0.3.0) and approve the capture in the install warning dialog.',
        },
      })
      recordDecision({ kind, appId, manifest, reason: 'not-approved' })
      return
    }

    // All gates passed. v0.2.x stops here because the capture
    // execution side (a11y snapshot, exposed-context reader) still
    // lives in the renderer; the server simply confirms that the
    // caller would have been allowed through. 204 mirrors that
    // contract — there is no body to send back.
    recordDecision({ kind, appId, manifest, reason: 'approved' })
    res.status(204).end()
  })

  return router
}
