/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture bridge — implementation of `window.kb.capture.<kind>`.
 *
 * The v0.2.0 opt-in mechanism (Phase 1 prompt-injection ①) splits
 * its verification across four layers (spec
 * `recipe-system.md` v1.6 §6.10 / `app-directory-extension.md` v1.3
 * §10.5.2):
 *
 *   - declaration (`manifest.captureRequires`)
 *   - consent (`manifest.approvedCaptures`)
 *   - source authentication (per-recipe-page capture token,
 *     v1.6 §6.10.6 / I-CR4 / I-CR5)
 *   - enforcement (server router at `/api/app/capture/<kind>`)
 *
 * This module is the client-side glue that owns layer 3 on the
 * recipe page. At mount time the bridge calls
 * `POST /api/app/capture-token/issue` and caches the resulting
 * token in a **closure variable** — never in `localStorage` /
 * `sessionStorage` (I-CR4 / spec v1.6 §6.10.6.2 SSOT). Every
 * `window.kb.capture.<kind>()` call attaches the token via
 * `X-KB-Capture-Token`; the server resolves the token to the
 * authoritative `appId`, so a forged `req.body.appId` cannot
 * borrow another app's authorisation (cross-app capability theft
 * is structurally prevented).
 *
 * On unmount, `injectKb` invokes `revokeToken()` which calls
 * `POST /api/app/capture-token/revoke` and clears the closure.
 * Network failures during revoke only log a warning — KB process
 * termination eventually wipes the server-side in-memory store
 * (I-CR5).
 *
 * Per spec v1.3 §10.5.2 "server-side 403 reception", token-related
 * 403s (`capture-token-missing` / `-invalid` / `-expired`) are
 * collapsed into `CaptureNotApprovedError` on the client so attackers
 * cannot use the error code as a token oracle. The technical reason
 * is preserved via the log line but not surfaced to recipe code.
 *
 * @stable v0.2.0
 */

import type { RendererLogger } from './logger'
import type { CaptureKindValue } from '../../shared/recipe-types'

/**
 * Capture kinds the v0.2.x bridge knows about.
 *
 * Aliases the canonical {@link CaptureKindValue} declared in
 * `src/shared/recipe-types.ts` so the parser, the install
 * validator, the server-side capture router, and this client-side
 * runtime guard all reference the same closed enum.
 */
export type CaptureKind = CaptureKindValue

/**
 * Public surface of the recipe-scoped capture bridge.
 *
 * `injectKb` calls `issueToken()` from a useEffect at mount time
 * and `revokeToken()` from the matching cleanup. The capture
 * methods (`a11y` / `exposedContext`) are exposed on
 * `window.kb.capture` to recipe code.
 */
export interface CaptureBridge {
  a11y: () => Promise<void>
  exposedContext: () => Promise<void>
  /**
   * Issue a capture token for the bound `appId`. Resolves once the
   * mount-time exchange has completed (success, grandfather skip,
   * or store-full / network failure). Subsequent capture calls
   * read the cached token.
   */
  issueToken: () => Promise<void>
  /**
   * Revoke the cached token and clear the closure. Idempotent —
   * safe to call twice during React cleanup races. Resolves
   * regardless of the server response (network failures only log).
   */
  revokeToken: () => Promise<void>
}

interface CaptureBridgeOptions {
  appId: string
  /**
   * Optional client-side cache of `manifest.captureRequires`
   * (v0.2.0 / spec v1.5). Used to short-circuit the declaration
   * step (`CaptureNotDeclaredError`) before any network round-trip.
   * Independent of the capture-token mechanism.
   */
  captureRequires?: readonly CaptureKind[]
  /**
   * Optional client-side cache of `manifest.approvedCaptures`.
   * Short-circuits the consent step. Server-side verification
   * remains authoritative (spec v1.3 §10.5.2).
   */
  approvedCaptures?: readonly CaptureKind[]
  log: RendererLogger
}

/**
 * Server response shape for `POST /api/app/capture-token/issue`.
 * Mirrors `http-api-contract.md` v1.4 §10.6.7.1.
 */
interface IssueResponseBody {
  token?: string | null
  expiresAt?: number | null
  reason?: 'grandfather-no-capture' | null
}

/**
 * Build the recipe-scoped `kb.capture` surface.
 *
 * The returned object is consumed by `injectKb` and surfaces on
 * `window.kb.capture` while a recipe page is mounted. The capture
 * methods themselves throw early if the local cache rules out the
 * call; otherwise they POST to `/api/app/capture/<kind>` with the
 * cached token in the `X-KB-Capture-Token` header.
 */
export function createCaptureBridge(opts: CaptureBridgeOptions): CaptureBridge {
  const { appId, captureRequires, approvedCaptures, log } = opts
  const declaredSet =
    captureRequires === undefined ? null : new Set<CaptureKind>(captureRequires)
  const approvedSet =
    approvedCaptures === undefined ? null : new Set<CaptureKind>(approvedCaptures)

  /**
   * Mount-lifetime closure for the capture token. `null` means
   * "no token available — fail-fast every capture call". The token
   * is intentionally NOT placed on `window`, `localStorage`, or any
   * other DOM-readable surface (I-CR4); only this closure holds it.
   */
  let cachedToken: string | null = null
  /**
   * Tracks the grandfather-skip path so subsequent fail-fast calls
   * can throw `CaptureNotDeclaredError` (server-side equivalent of
   * a grandfather recipe). When the issue endpoint replied 503 /
   * network error instead, we throw `CaptureNotApprovedError`
   * because the cause is opaque to the recipe code.
   */
  let issueOutcome: 'pending' | 'ok' | 'grandfather' | 'unavailable' = 'pending'

  async function issueToken(): Promise<void> {
    let response: Response
    try {
      response = await fetch('/api/app/capture-token/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId }),
      })
    } catch (err) {
      cachedToken = null
      issueOutcome = 'unavailable'
      log.warn({ appId, err }, 'capture-token issue: network error')
      return
    }

    if (response.status !== 200) {
      cachedToken = null
      issueOutcome = 'unavailable'
      log.warn(
        { appId, status: response.status },
        'capture-token issue: non-200 response',
      )
      return
    }

    let body: IssueResponseBody = {}
    try {
      body = (await response.json()) as IssueResponseBody
    } catch {
      // Empty / invalid JSON. Treat as unavailable.
    }

    if (body.reason === 'grandfather-no-capture' || body.token === null) {
      cachedToken = null
      issueOutcome = 'grandfather'
      log.info(
        { appId },
        'capture-token issue: grandfather skip (recipe declares no capture)',
      )
      return
    }

    if (typeof body.token === 'string' && body.token.length > 0) {
      cachedToken = body.token
      issueOutcome = 'ok'
      log.info({ appId }, 'capture-token issue: ok')
      return
    }

    // Shape we did not expect — defensively fail-fast.
    cachedToken = null
    issueOutcome = 'unavailable'
    log.warn({ appId }, 'capture-token issue: unexpected response shape')
  }

  async function revokeToken(): Promise<void> {
    const tokenToRevoke = cachedToken
    cachedToken = null
    issueOutcome = 'pending'
    if (tokenToRevoke === null) {
      return
    }
    try {
      await fetch('/api/app/capture-token/revoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kb-capture-token': tokenToRevoke,
        },
        body: '{}',
      })
    } catch (err) {
      // Revoke is best-effort — the server-side store has a TTL
      // and the process-exit cleanup will eventually drop the
      // entry anyway. Log so operators can spot persistent
      // failures.
      log.warn({ appId, err }, 'capture-token revoke: network error')
    }
  }

  async function callServer(kind: CaptureKind): Promise<void> {
    // Local fast-path on the declaration / consent caches. Step
    // order matches the server (declaration first, consent second)
    // so recipe authors see the same diagnostic regardless of
    // which side refused.
    if (declaredSet !== null && !declaredSet.has(kind)) {
      const err = new CaptureNotDeclaredError(kind, appId)
      log.warn({ kind, appId }, `capture ${kind}: refused by client-side guard (not declared)`)
      throw err
    }
    if (approvedSet !== null && !approvedSet.has(kind)) {
      const err = new CaptureNotApprovedError(kind, appId)
      log.warn({ kind, appId }, `capture ${kind}: refused by client-side guard (not approved)`)
      throw err
    }

    // Token gate. A `null` cache means the issue path either
    // skipped (grandfather) or failed (store full, network). We
    // refuse without a network round-trip so the call is cheap
    // even when capture is structurally disabled for the page.
    if (cachedToken === null) {
      if (issueOutcome === 'grandfather') {
        const err = new CaptureNotDeclaredError(kind, appId)
        log.warn(
          { kind, appId },
          `capture ${kind}: refused by client-side guard (grandfather-no-capture)`,
        )
        throw err
      }
      const err = new CaptureNotApprovedError(kind, appId)
      log.warn(
        { kind, appId, outcome: issueOutcome },
        `capture ${kind}: refused by client-side guard (no token)`,
      )
      throw err
    }

    let response: Response
    try {
      response = await fetch(`/api/app/capture/${encodeURIComponent(kind)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // I-CR4: the token is the only field that establishes
          // app identity on the wire. Do NOT pass `appId` in the
          // body — `req.body.appId` is ignored on the server side
          // precisely to prevent cross-app capability theft, but
          // sending it would be a misleading lie to log readers.
          'x-kb-capture-token': cachedToken,
        },
        body: '{}',
      })
    } catch (err) {
      log.warn({ kind, appId, err }, `capture ${kind}: network error`)
      throw new CaptureNetworkError(kind, err)
    }

    if (response.status === 204) {
      return
    }

    let body: Record<string, unknown> = {}
    try {
      body = (await response.json()) as Record<string, unknown>
    } catch {
      // Empty / invalid JSON; fall through with empty body.
    }
    const code = typeof body.error === 'string' ? body.error : 'CaptureFailed'
    const message =
      typeof body.message === 'string'
        ? body.message
        : `Capture call failed with HTTP ${response.status}`
    const details =
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : {}
    const serverReason =
      typeof details.reason === 'string' ? details.reason : null

    log.warn(
      { kind, appId, status: response.status, code, serverReason },
      `capture ${kind}: refused by server`,
    )

    // Spec `app-directory-extension.md` v1.3 §10.5.2 "server-side
    // 403 reception": token-shape failures are remapped to
    // `CaptureNotApprovedError` on the client so attackers cannot
    // distinguish "no token" from "token expired" from "token
    // invalid". The technical reason stays in the warn log above.
    if (
      serverReason === 'capture-token-missing' ||
      serverReason === 'capture-token-invalid' ||
      serverReason === 'capture-token-expired' ||
      serverReason === 'no-matching-manifest'
    ) {
      throw new CaptureNotApprovedError(kind, appId)
    }

    throw new CaptureRejectedError(code, message, response.status)
  }

  return {
    a11y: () => callServer('a11y'),
    exposedContext: () => callServer('exposed-context'),
    issueToken,
    revokeToken,
  }
}

/**
 * Thrown when the client-side cache refuses a capture call at the
 * declaration step (step 3, `manifest.captureRequires`) or when
 * the grandfather skip blocks the call before the token round-trip.
 * Surfaces the same `error.code` value as the server's 403 envelope
 * so recipe authors can branch on it without inspecting whether the
 * call reached the network. See `recipe-system.md` v1.5 §6.10.3
 * I-CR3 for the step-3 / step-4 split.
 */
export class CaptureNotDeclaredError extends Error {
  readonly code = 'CaptureNotDeclared'
  readonly kind: CaptureKind
  readonly appId: string

  constructor(kind: CaptureKind, appId: string) {
    super(`Capture '${kind}' is not declared by this recipe (appId: ${appId}).`)
    this.name = 'CaptureNotDeclaredError'
    this.kind = kind
    this.appId = appId
  }
}

/**
 * Thrown when the client-side cache or the server-side gate
 * refuses a capture call at the consent step (step 4,
 * `manifest.approvedCaptures`), or when the token round-trip
 * failed for any reason (token missing / invalid / expired,
 * server-side manifest race, store full, network error). The
 * shared error code keeps the token mechanism from leaking
 * structural information to recipe authors.
 */
export class CaptureNotApprovedError extends Error {
  readonly code = 'CaptureNotApproved'
  readonly kind: CaptureKind
  readonly appId: string

  constructor(kind: CaptureKind, appId: string) {
    super(`Capture '${kind}' is not approved for this recipe (appId: ${appId}).`)
    this.name = 'CaptureNotApprovedError'
    this.kind = kind
    this.appId = appId
  }
}

/**
 * Thrown when the server-side gate refuses the call with a reason
 * other than the token-shape family. Wraps the structured envelope
 * (`error` + `message` + `details`) the server emitted so recipe
 * authors can branch on `error.code` instead of regex'ing the
 * message.
 */
export class CaptureRejectedError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'CaptureRejectedError'
    this.code = code
    this.status = status
  }
}

/**
 * Thrown when the underlying fetch fails before the server could
 * respond. The `cause` field carries the original error so the
 * caller can introspect it (e.g. distinguish AbortError from a DNS
 * failure).
 */
export class CaptureNetworkError extends Error {
  readonly code = 'CaptureNetworkError'
  readonly cause: unknown

  constructor(kind: CaptureKind, cause: unknown) {
    super(`Capture '${kind}' failed to reach the server`)
    this.name = 'CaptureNetworkError'
    this.cause = cause
  }
}
