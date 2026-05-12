/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture endpoint opt-in router (v0.2.0, Phase 1 prompt-injection ①).
 *
 * Mounts under `/api/app/capture` and serves the runtime side of the
 * four-layer opt-in mechanism described in `recipe-system.md` v1.6
 * §6.10 / `http-api-contract.md` v1.4 §10.6 /
 * `app-directory-extension.md` v1.3 §10.5.2:
 *
 *   - layer 1 (declaration):   the recipe's `recipe.yaml` lists the
 *     capture kinds it wants under `capture.requires`. Persisted
 *     onto the manifest as `captureRequires`.
 *   - layer 2 (consent):       the install warning dialog records
 *     the subset the user agreed to as `approvedCaptures`. Bound
 *     by I-CR1 (`approvedCaptures ⊆ captureRequires`).
 *   - layer 3 (source auth):   the per-recipe-page capture token
 *     (v1.6, I-CR4 / I-CR5) carried in `X-KB-Capture-Token` proves
 *     the call came from the mounted recipe rather than a forged
 *     `req.body.appId`. The server resolves the token via
 *     `recipe-capture-sessions.consumeCaptureToken` and derives
 *     the authoritative `appId` from the store.
 *   - layer 4 (enforcement):   this router runs the canonical
 *     5-step verification — step 1 closed-enum check, step 2
 *     token verification, step 3 declaration check, step 4
 *     consent check, step 5 success / audit — with steps 3 and 4
 *     enforced independently per I-CR3.
 *
 * Grandfather manifests (installed before v0.2.0) migrate to
 * `captureRequires: []` and never receive a capture token (spec
 * v1.6 §6.10.6.7). Their calls fail-fast on the client and never
 * reach this router; if they ever do, they land on step 4
 * (`CaptureNotDeclared`) the same way.
 *
 * The router writes one `_capture-audit.log` entry per request —
 * both accepts and refuses — across every reason in
 * {@link CaptureAuditReason}. Requests that did not resolve to an
 * appId (`capture-token-*`, `no-matching-manifest`, unknown
 * literal kind) land in the global sink at
 * `app/_unresolved-capture-audit.log` so forged / probing traffic
 * stays visible alongside legitimate refuses.
 *
 * @see docs/design/handoffs/v02x-phase1-capture-optin-implementation-request.md v1.2
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
import { consumeCaptureToken } from '../recipe-capture-sessions.js'
import { getMount } from '../recipe-capture-mount-sessions.js'

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

/**
 * Build the `/api/app/capture` router.
 *
 * Each `/api/app/capture/<kind>` endpoint runs the 5-step
 * verification flow from `http-api-contract.md` v1.4 §10.6.3:
 *
 *   1. `<kind>` path segment must belong to the closed `CaptureKind`
 *      enum — anything else short-circuits to `CaptureNotDeclared`
 *      with reason `not-declared`. The audit entry uses
 *      `kind: null` + `rawKind: <segment>` so probe traffic stays
 *      traceable.
 *   2. `X-KB-Capture-Token` header must resolve to a live token in
 *      `recipe-capture-sessions`. Missing → reason
 *      `capture-token-missing`; malformed / unknown → reason
 *      `capture-token-invalid`; past `expiresAt` → reason
 *      `capture-token-expired`. `req.body.appId` is NEVER read —
 *      cross-app capability theft is prevented at this layer
 *      (I-CR4).
 *   3. The token's `appId` must resolve to a live manifest.
 *      Otherwise reason `no-matching-manifest` (rare —
 *      uninstall race after token issue).
 *   4. `manifest.captureRequires.includes(kind)` — otherwise
 *      `CaptureNotDeclared` with reason `not-declared` (I-CR3).
 *   5. `manifest.approvedCaptures.includes(kind)` — otherwise
 *      `CaptureNotApproved` with reason `not-approved` (I-CR3).
 *
 * The success path returns 204 No Content — the actual capture
 * work still lives in the renderer in v0.2.x; the router is the
 * gate.
 */
export function createCaptureRouter(opts: CreateCaptureRouterOptions): Router {
  const router = Router()
  const { manifestStore, projectRoot, logger } = opts

  /**
   * Local helper that emits a structured audit entry and forwards
   * to whichever sink the entry's appId resolves to. The pino
   * logger line goes out alongside so operators see both signals.
   *
   * `kind` is `CaptureKind | null` — the latter covers the
   * unknown-literal-kind probe. `rawKind` always retains the
   * wire-level path segment (truncated) so log readers can trace
   * the probe back to its input even when the kind enum cannot
   * represent it.
   */
  function recordDecision(params: {
    kind: CaptureKind | null
    rawKind: string
    appId: string | null
    manifest: RecipeManifest | null
    reason: CaptureAuditReason
  }): void {
    const { kind, rawKind, appId, manifest, reason } = params
    const entry: CaptureAuditEntry = {
      timestamp: new Date().toISOString(),
      appId,
      recipeId: manifest ? manifest.recipeId : null,
      kind,
      rawKind,
      trustLevel: manifest ? manifest.trustLevel : null,
      result: reason === 'approved' ? 'success' : 'rejected',
      reason,
    }
    writeCaptureAuditLog(entry, projectRoot)
    logger.info(
      {
        kind,
        rawKind,
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
    const rawKind = kindParam.slice(0, 64)

    // Step 1: closed-enum check on the path segment. An unknown
    // literal collapses to CaptureNotDeclared because the manifest
    // cannot declare a kind that v0.2.x doesn't recognise. The
    // audit-log entry uses `kind: null` + `rawKind: <segment>` so
    // probe attempts (e.g. `/api/app/capture/camera`) are recorded
    // in the global sink per spec v1.6 §6.10.5 "all decisions".
    if (!isValidCaptureKind(kindParam)) {
      res.status(403).json({
        error: 'CaptureNotDeclared',
        message: `Capture '${rawKind}' is not a known capture kind.`,
        details: {
          kind: rawKind,
          reason: 'not-declared',
          remediation:
            'Use one of the kinds declared by the v0.2.x capture surface ' +
            '(a11y, exposed-context).',
        },
      })
      recordDecision({
        kind: null,
        rawKind,
        appId: null,
        manifest: null,
        reason: 'not-declared',
      })
      return
    }
    const kind: CaptureKind = kindParam

    // Step 2: capture-token verification. Spec v1.6 §6.10.6 / v1.4
    // §10.6.3 step 2: the server reads the `X-KB-Capture-Token`
    // header, looks it up in the in-memory store, and derives the
    // authoritative `appId` from the record. `req.body.appId` is
    // never read (I-CR4) — a forged body field cannot escalate the
    // call into another app's identity.
    const headerToken = req.header('x-kb-capture-token')
    if (typeof headerToken !== 'string' || headerToken.length === 0) {
      res.status(403).json({
        error: 'NoActiveRecipe',
        message:
          'Capture call must include a server-issued capture token in the ' +
          'X-KB-Capture-Token header. Mount a recipe page so window.kb.capture ' +
          'attaches the token automatically.',
        details: {
          kind,
          reason: 'capture-token-missing',
          remediation:
            'Use window.kb.capture.<kind>() from a mounted recipe page. The ' +
            'bridge issues the token at mount time and forwards it on every call.',
        },
      })
      recordDecision({
        kind,
        rawKind,
        appId: null,
        manifest: null,
        reason: 'capture-token-missing',
      })
      return
    }

    const tokenResult = consumeCaptureToken(headerToken)
    if (!tokenResult.ok) {
      const reason: CaptureAuditReason =
        tokenResult.reason === 'expired'
          ? 'capture-token-expired'
          : 'capture-token-invalid'
      res.status(403).json({
        error: 'NoActiveRecipe',
        message:
          reason === 'capture-token-expired'
            ? 'Capture token has expired. The recipe page must remount to mint a fresh token.'
            : 'Capture token is invalid (malformed or never issued).',
        details: {
          kind,
          reason,
          remediation:
            'Reload the recipe page so window.kb.capture re-issues the token.',
        },
      })
      recordDecision({
        kind,
        rawKind,
        appId: null,
        manifest: null,
        reason,
      })
      return
    }

    // Spec v1.7 §6.10.6.4 / v1.5 §10.6.3 step 2: token → mountId →
    // mountStore → appId. The token record cached the appId at
    // issue time, but the authoritative chain runs through
    // mountStore so a mount that was closed (or expired) between
    // token issue and the capture call still surfaces as
    // `mount-not-found` rather than letting a stale token authorise
    // a capture against a dead mount.
    const tokenMountId = tokenResult.mountId
    const mountResult = getMount(tokenMountId)
    if (!mountResult.ok) {
      res.status(403).json({
        error: 'NoActiveRecipe',
        message:
          'Capture token references a mount that is no longer active. ' +
          'The recipe page may have unmounted between token issue and the capture call.',
        details: {
          kind,
          reason: 'mount-not-found',
          remediation:
            'Reload the recipe page so a fresh mount + token is issued.',
        },
      })
      recordDecision({
        kind,
        rawKind,
        appId: null,
        manifest: null,
        reason: 'mount-not-found',
      })
      return
    }
    const appId = mountResult.appId

    const manifest = manifestStore.get(appId)
    if (!manifest) {
      // Rare race: the token's `appId` resolved cleanly but the
      // manifest was uninstalled between issuance and the capture
      // call. Audit lands in the global sink because the
      // post-uninstall path can no longer write into the per-app
      // file safely.
      res.status(403).json({
        error: 'NoActiveRecipe',
        message:
          `Capture token references appId "${appId}" but no installed recipe matches.`,
        details: {
          kind,
          appId,
          reason: 'no-matching-manifest',
          remediation:
            'The recipe was likely uninstalled mid-session. Reinstall and reload the recipe page.',
        },
      })
      recordDecision({
        kind,
        rawKind,
        appId: null,
        manifest: null,
        reason: 'no-matching-manifest',
      })
      return
    }

    const trustLevel = manifest.trustLevel

    // Step 3: declaration check (I-CR3). The manifest's
    // `captureRequires` is the authoritative declared surface; a
    // kind missing from it is `CaptureNotDeclared` regardless of
    // approval state. Grandfather installs cannot reach this
    // branch because they never receive a token (spec v1.6
    // §6.10.6.7), but the check stays in place defensively.
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
      recordDecision({ kind, rawKind, appId, manifest, reason: 'not-declared' })
      return
    }

    // Step 4: consent check (I-CR3). The declared surface contains
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
      recordDecision({ kind, rawKind, appId, manifest, reason: 'not-approved' })
      return
    }

    // All gates passed. v0.2.x stops here because the capture
    // execution side (a11y snapshot, exposed-context reader) still
    // lives in the renderer; the server simply confirms that the
    // caller would have been allowed through. 204 mirrors that
    // contract — there is no body to send back.
    recordDecision({ kind, rawKind, appId, manifest, reason: 'approved' })
    res.status(204).end()
  })

  return router
}
