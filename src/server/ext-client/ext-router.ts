/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * External-client HTTP router (external-client-api.md v1.0 §5 / §6.1 /
 * §7).
 *
 * Mounts the `/api/ext/_client/v1/*` namespace. This router is mounted
 * in `index.ts` BEFORE the existing broad `app.use('/api',
 * verifyTokenAndOrigin)` guard (§5.2, P-7) so extension requests are
 * handled by the dedicated extension guard here and never intercepted
 * by the loopback-only `/api/*` guard. Every route in this router
 * terminates the request (it does NOT `next()` into the `/api` guard).
 *
 * Authentication layering (§5.2 / §7.1):
 *   - `/pair`   — pre-guard special route, pairing-code authenticated,
 *                 token NOT required (§7.2.2).
 *   - `/token`  — origin-two-step only (step 1+2), token check skipped
 *                 (§7.2.4) so a stale-token client can re-fetch.
 *   - all other — full extension guard: paired + exact origin + token.
 *
 * Routes that "merge into existing logic" (`agents`, `sessions/new`,
 * `sessions/:id/send`) call injected handler functions so the existing
 * business logic in `index.ts` is reused verbatim without duplicating
 * it or exposing it through the loopback guard.
 *
 * The launch token is NOT touched here; it is compared via the injected
 * `tokensMatchLaunchToken` so the canonical timing-safe compare in
 * `auth.ts` stays the single source of truth.
 */
import express, { type Request, type Response, type Router } from 'express'
import type { PairingStore } from './pairing-store'
import type { OwnershipRegistry } from './ownership-registry'
import { parseExtensionOrigin } from '../middleware/ext-origin'

/** Mount prefix for the external-client API (§5.1, case-B namespace). */
export const EXT_CLIENT_MOUNT_PREFIX = '/api/ext/_client/v1'

/**
 * Upper bound on the correlation / id fields a paired extension may
 * send (agentId / clientRequestId / sessionId). Matches the WS path's
 * cap so the HTTP and WS validation are consistent and oversized ids
 * cannot sit in registry maps until TTL (external-client-api.md v1.0
 * §8.4 hardening).
 */
export const MAX_EXT_ID_LEN = 256

/** capabilities response (§6.3). Frozen so callers cannot mutate it. */
const CAPABILITIES = Object.freeze({
  apiVersion: 1,
  supportedFeatures: Object.freeze(['shared-chat', 'per-client-subscribe', 'pairing']),
  minClientVersion: null,
})

/** Dependencies injected from `index.ts` so the router stays testable. */
export interface ExtRouterDeps {
  pairing: PairingStore
  registry: OwnershipRegistry
  /** Current per-launch token (rotation-aware; read on each request). */
  getLaunchToken: () => string
  /** Canonical timing-safe launch-token compare (from `auth.ts`). */
  tokensMatchLaunchToken: (actual: string | undefined, expected: string) => boolean
  /**
   * Called on a successful re-pairing OVERWRITE (the paired id changed)
   * so `index.ts` can synchronously close the old extension's WS
   * connections and drop their subscription sets (§7.2.1 TOCTOU). The
   * registry is cleared here in the router before invoking it.
   */
  onRepairOverwrite: (oldExtensionId: string | null, newExtensionId: string) => void
  /** Operator-only logging hook for swallowed async handler rejections. */
  onAsyncError: (err: unknown) => void
  /** Reuse the existing `GET /api/agents` business logic verbatim. */
  handleAgentsList: (req: Request, res: Response) => void
  /**
   * Reuse the existing `POST /api/sessions/new` logic for ext launches.
   * The router has already reserved the launch (minted launchId, marked
   * in-flight) and set `origin='extension'`; this delegate performs the
   * tmux/claude side effects and the origin reservation.
   */
  handleExtSessionNew: (
    req: Request,
    res: Response,
    ctx: { agentId: string; launchId: string },
  ) => void | Promise<void>
  /** Reuse the existing `POST /api/sessions/:id/send` logic verbatim. */
  handleSessionSend: (req: Request, res: Response) => void | Promise<void>
}

/**
 * Build the extension guard middleware (§7.1 step 1–3). Applied to
 * every route EXCEPT `/pair` and `/token`, which have their own
 * narrower checks.
 */
function buildExtensionGuard(deps: ExtRouterDeps) {
  return function extensionGuard(req: Request, res: Response, next: express.NextFunction): void {
    // Step 1: paired?
    const allowedExtensionId = deps.pairing.getAllowedExtensionId()
    if (allowedExtensionId === null) {
      res.status(403).json({ error: 'Extension not paired' })
      return
    }
    // Step 2: exact origin parse + allowedExtensionId match.
    const id = parseExtensionOrigin(req.headers.origin)
    if (id === null || id !== allowedExtensionId) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }
    // Step 3: launch token.
    const headerValue = req.headers['x-kovitoboard-token']
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue
    if (!deps.tokensMatchLaunchToken(headerToken, deps.getLaunchToken())) {
      res.setHeader('WWW-Authenticate', 'KbLaunchToken')
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    next()
  }
}

export function createExtClientRouter(deps: ExtRouterDeps): Router {
  const router = express.Router()
  const extGuard = buildExtensionGuard(deps)

  // --- /pair (pre-guard special route, pairing-code auth, §7.2.2) ---
  // The exact-origin check runs in a middleware BEFORE `express.json()`
  // so a non-extension origin is rejected without ever parsing a body —
  // mirroring the existing `/api` design where auth precedes body
  // parsing (no pre-token, pre-origin JSON-parsing DoS surface). The
  // route-scoped JSON parser is used because the global `express.json()`
  // is mounted AFTER this router.
  const pairOriginGate = (req: Request, res: Response, next: express.NextFunction): void => {
    // §7.2.2: exact origin parse step 1–4 (no allowedExtensionId match
    // yet — the id is not confirmed until this request succeeds).
    if (parseExtensionOrigin(req.headers.origin) === null) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }
    next()
  }
  // Catch `express.json()`'s parse error so malformed JSON returns the
  // documented `{ error: 'Bad request' }` envelope (400) rather than
  // Express' default error response, which can be HTML and — in
  // development — carry a stack trace / paths on this pre-token route.
  const jsonParseErrorGate = (
    err: unknown,
    _req: Request,
    res: Response,
    next: express.NextFunction,
  ): void => {
    if (err) {
      res.status(400).json({ error: 'Bad request' })
      return
    }
    next()
  }
  const handlePair = (req: Request, res: Response): void => {
    // Origin already validated by `pairOriginGate`; re-derive the id.
    const originId = parseExtensionOrigin(req.headers.origin)!
    const body = req.body as { pairingCode?: unknown; extensionId?: unknown } | undefined
    if (
      !body ||
      typeof body.pairingCode !== 'string' ||
      typeof body.extensionId !== 'string'
    ) {
      res.status(400).json({ error: 'Bad request' })
      return
    }
    // The confirmed id must be the requester's own origin id (§7.2.2).
    if (body.extensionId !== originId) {
      res.status(400).json({ error: 'extensionId mismatch' })
      return
    }

    const before = deps.pairing.getAllowedExtensionId()
    const result = deps.pairing.tryPair(body.pairingCode, body.extensionId)
    if (!result.ok) {
      switch (result.reason) {
        case 'no-active-pairing':
          res.status(401).json({ error: 'No active pairing' })
          return
        case 'expired':
          res.status(401).json({ error: 'Pairing code expired' })
          return
        case 'mismatch':
          res.status(401).json({ error: 'Invalid pairing code' })
          return
      }
    }

    // Any successful pairing resets the single slot (§7.2.1): drop the
    // ownership registry and revoke + close the previously-paired
    // extension's WS connections synchronously before returning the
    // token. This applies even when the SAME extension id re-pairs — a
    // fresh user-initiated pairing starts a fresh session boundary, so
    // stale sockets / subscriptions / owned sessions / in-flight
    // launches from before the re-pair must not survive. `before ===
    // null` (first pairing this launch) just clears an already-empty
    // registry and has no sockets to revoke.
    deps.registry.clear()
    if (before !== null) {
      deps.onRepairOverwrite(before, result.extensionId)
    }

    res.json({ token: deps.getLaunchToken() })
  }
  router.post('/pair', pairOriginGate, express.json(), jsonParseErrorGate, handlePair)

  // --- /token (origin-only, token NOT required, §7.2.4) ---
  router.get('/token', (req, res) => {
    const allowedExtensionId = deps.pairing.getAllowedExtensionId()
    if (allowedExtensionId === null) {
      // §7.1 step 1: unpaired (incl. post-restart) → 403 fail-closed.
      res.status(403).json({ error: 'Extension not paired' })
      return
    }
    const id = parseExtensionOrigin(req.headers.origin)
    if (id === null || id !== allowedExtensionId) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }
    res.json({ token: deps.getLaunchToken() })
  })

  // --- capabilities (full guard, §7.4) ---
  router.get('/capabilities', extGuard, (_req, res) => {
    res.json(CAPABILITIES)
  })

  // --- agents (full guard, merges into GET /api/agents, §6.1) ---
  router.get('/agents', extGuard, (req, res) => {
    deps.handleAgentsList(req, res)
  })

  // --- sessions/new (full guard, §6.1 / §7.3) ---
  router.post('/sessions/new', extGuard, express.json(), (req, res) => {
    runAsync(res, handleExtNew(deps, req, res), deps.onAsyncError)
  })

  // --- sessions/:id/send (full guard, §6.1) ---
  router.post('/sessions/:id/send', extGuard, express.json(), (req, res) => {
    const sessionId = String(req.params.id)
    // Bound the sessionId length BEFORE the registry lookup, matching the
    // WS path's MAX_WS_ID_LEN cap so an oversized id cannot reach the
    // ownership map (external-client-api.md v1.0 §8.4 hardening, HTTP/WS
    // parity).
    if (sessionId.length === 0 || sessionId.length > MAX_EXT_ID_LEN) {
      res.status(403).json({ error: 'Session not owned' })
      return
    }
    if (!deps.registry.isOwned(sessionId)) {
      res.status(403).json({ error: 'Session not owned' })
      return
    }
    runAsync(res, Promise.resolve(deps.handleSessionSend(req, res)), deps.onAsyncError)
  })

  return router
}

/**
 * Catch a rejected async handler so a thrown error does not leave the
 * request hanging or surface as an unhandled rejection. If the response
 * has not been sent yet, reply with a 500; otherwise the response is
 * already committed and we only swallow the rejection. The detail is
 * forwarded to the injected `onError` hook for operator logging (no
 * client leak). Express 5 propagates returned-promise rejections to its
 * error handler, but this router has no custom error middleware, so we
 * terminate explicitly here.
 */
function runAsync(res: Response, p: Promise<unknown>, onError?: (err: unknown) => void): void {
  void p.catch((err: unknown) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' })
    }
    if (onError) onError(err)
  })
}

/**
 * Ext new-session reservation (§7.3.1 step 1–2 for the HTTP path).
 * Validates the ext-specific fields, enforces same-agentId
 * serialisation, registers the launch (minting a launchId), forces
 * `origin='extension'`, then delegates to the injected handler which
 * runs the existing `sessions/new` side effects and reservation.
 *
 * The HTTP response returns `{ launchId }` immediately so the client
 * can correlate the later `new_session` echo across multiple WS
 * connections (§7.3.1 step 4c).
 */
async function handleExtNew(deps: ExtRouterDeps, req: Request, res: Response): Promise<void> {
  const body = req.body as { agentId?: unknown; clientRequestId?: unknown } | undefined
  if (
    !body ||
    typeof body.agentId !== 'string' ||
    body.agentId.length === 0 ||
    body.agentId.length > MAX_EXT_ID_LEN
  ) {
    res.status(400).json({ error: 'agentId must be a non-empty bounded string' })
    return
  }
  if (
    typeof body.clientRequestId !== 'string' ||
    body.clientRequestId.length === 0 ||
    body.clientRequestId.length > MAX_EXT_ID_LEN
  ) {
    res.status(400).json({ error: 'clientRequestId must be a non-empty bounded string' })
    return
  }
  const agentId = body.agentId
  const clientRequestId = body.clientRequestId

  // §7.2.1 TOCTOU (HTTP path): `extGuard` validated the pairing/origin
  // BEFORE `express.json()` streamed the body. A re-pair (overwrite to a
  // different extension) can land DURING a slow body stream; that path
  // synchronously clears the registry and terminates the old WS sockets,
  // but an in-flight HTTP request is not a WS socket and survives. If we
  // proceeded, the now-revoked extension would register a launch under
  // the new pairing. Re-validate the pairing + exact origin here, after
  // the body has parsed and just before we mutate the registry, so a
  // request whose pairing changed mid-stream is refused.
  const currentAllowedId = deps.pairing.getAllowedExtensionId()
  const originId = parseExtensionOrigin(req.headers.origin)
  if (currentAllowedId === null || originId === null || originId !== currentAllowedId) {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }

  // §7.3.1 step 1: reject if the agent is in-flight (ext-vs-ext) OR has
  // a pending origin reservation on any path (ext-vs-renderer). The
  // cross-origin reservation check is performed inside the injected
  // handler (which has access to the SessionManager); here we only
  // guard the ext-vs-ext case via the registry.
  if (deps.registry.isAgentInFlight(agentId)) {
    res.status(409).json({ error: 'Agent launch in-flight' })
    return
  }

  const reg = deps.registry.registerLaunch({
    agentId,
    originConnId: null, // HTTP path has no WS connection.
    clientRequestId,
  })
  if (!reg.ok) {
    if (reg.reason === 'duplicate-client-request') {
      // §8.5: a clientRequestId still pending must not start a second
      // launch — the client owns minting a fresh id per request.
      res.status(409).json({ error: 'Duplicate clientRequestId' })
      return
    }
    res.status(409).json({ error: 'Agent launch in-flight' })
    return
  }

  // Force origin='extension' regardless of any client-supplied value.
  ;(req.body as Record<string, unknown>).origin = 'extension'
  await deps.handleExtSessionNew(req, res, { agentId, launchId: reg.launchId })
}
