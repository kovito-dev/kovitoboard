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
 *   - `/pair`           — pre-guard special route, pairing-code
 *                         authenticated, token NOT required (§7.2.2).
 *                         Response carries `{ token, refreshSecret }`.
 *   - `/token/refresh`  — token-free, but two-factor: present-Origin
 *                         exact-match (first factor) + body
 *                         `refreshSecret` (second factor, §7.2.4 / (c1))
 *                         so a stale-token client can re-fetch the token
 *                         while a DNR-Origin-spoofing extension that lacks
 *                         the refresh secret is structurally refused.
 *   - all other         — full extension guard: paired + token. The exact
 *                         origin check is method-aware (§7.1 step 2,
 *                         P-17): a token-authed GET (`/capabilities`,
 *                         `/agents`) accepts a MISSING `Origin` header and
 *                         delegates to the token gate (the MV3 service
 *                         worker omits `Origin` on GET), while a mutating
 *                         POST requires present-Origin exact-match.
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
import type { ExtAgentExistence } from './agent-existence'
import { MAX_EXT_ID_LEN, MAX_PRE_AUTH_BODY_SIZE } from './limits'
import { parseExtensionOrigin } from '../middleware/ext-origin'

/** Mount prefix for the external-client API (§5.1, case-B namespace). */
export const EXT_CLIENT_MOUNT_PREFIX = '/api/ext/_client/v1'

// `MAX_EXT_ID_LEN` (the external-client id-field cap) lives in the
// shared `limits` module so the HTTP and WS paths share ONE source of
// truth (external-client-api.md §8.4 hardening, HTTP/WS parity). It is
// re-exported here so existing importers of this router keep working.
export { MAX_EXT_ID_LEN } from './limits'

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
  /**
   * Resolve whether an ext-supplied `agentId` names a real agent
   * definition (external-client-api.md v1.2 §10.4 R-7). Returns
   * `'exists'` to proceed, `'unknown'` for a well-formed but
   * non-existent agent (→ HTTP 400 `Unknown agentId`), or `'load-failed'`
   * when the definition set could not be built (→ HTTP 500 fail-closed,
   * NOT a fallback to bounded-string acceptance).
   */
  checkAgentExists: (agentId: string) => ExtAgentExistence
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
 * Whether an `Origin` header is absent — i.e. the header was not sent at
 * all (undefined) or is the empty string. This is distinct from a header
 * that IS present but is not a valid `chrome-extension://` origin (e.g. a
 * web origin), which must NOT be treated as absent (§7.1 step 2 / §5.3
 * N-1: a malicious web page CANNOT omit `Origin`, so an empty header is
 * structurally only reachable by an MV3 SW GET or a same-host non-browser
 * process — never by a web page). The §7.1 step 2-absent delegation is
 * keyed on header absence, NOT on `parseExtensionOrigin` returning null
 * (which also fires for a present-but-invalid origin that must 403).
 */
function isOriginHeaderAbsent(req: Request): boolean {
  const origin = req.headers.origin
  return origin === undefined || origin === ''
}

/**
 * Build the extension guard middleware (§7.1 step 1–3). Applied to every
 * route EXCEPT `/pair` and `/token/refresh`, which have their own
 * narrower checks.
 *
 * Step 2 is scoped per-route (§7.1 step 2 / P-17), NOT keyed on the HTTP
 * method. The absent-`Origin` delegation is opted into explicitly by the
 * two token-authed GET routes (`/capabilities`, `/agents`) via
 * `opts.allowOriginAbsent`, because the MV3 service worker omits `Origin`
 * on GET fetches — refusing the absent case would 403 every legitimate
 * GET. Every other route (the mutating POSTs `/sessions/new`,
 * `/sessions/:id/send`) keeps requiring present-Origin exact-match: the SW
 * always sends `Origin` on POST, so an absent-Origin POST is only a
 * crafted path and is refused. Pinning the relaxation to named routes
 * (rather than to `req.method === 'GET'`) keeps the scope exactly the two
 * spec-named endpoints, so a future GET added under this guard does not
 * silently inherit the absent-Origin relaxation. A present `Origin` is
 * always exact-matched on every route (a present web origin therefore
 * 403s on step 2, never reaching the absent-delegation path).
 */
function buildExtensionGuard(deps: ExtRouterDeps, opts: { allowOriginAbsent: boolean }) {
  return function extensionGuard(req: Request, res: Response, next: express.NextFunction): void {
    // Step 1: paired?
    const allowedExtensionId = deps.pairing.getAllowedExtensionId()
    if (allowedExtensionId === null) {
      res.status(403).json({ error: 'Extension not paired' })
      return
    }
    // Step 2: route-scoped exact-origin / absent-delegation (§7.1 step 2).
    const originAbsent = isOriginHeaderAbsent(req)
    if (originAbsent && opts.allowOriginAbsent) {
      // (2-absent) token-authed GET (capabilities / agents) with no Origin
      // header: skip the exact origin match and let the token gate (step 3)
      // be the sole authz boundary (P-17, mirrors the existing /api P-4
      // empty-Origin path). Only the two opted-in routes reach here.
    } else {
      // (2-present) — OR an absent Origin on a route that does NOT opt into
      // the relaxation (every mutating POST), which we refuse here via the
      // same exact-match path (parseExtensionOrigin returns null for an
      // empty header → 403).
      const id = parseExtensionOrigin(req.headers.origin)
      if (id === null || id !== allowedExtensionId) {
        res.status(403).json({ error: 'Origin not allowed' })
        return
      }
    }
    // Step 3: launch token (required on BOTH the present and absent
    // paths; on the absent GET path it is the sole authz boundary).
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
  // Two guard instances differing only in the §7.1 step 2 absent-Origin
  // policy. The token-authed GET routes (`/capabilities`, `/agents`) opt
  // into the absent-Origin delegation (the MV3 SW omits Origin on GET);
  // every mutating route uses the strict guard that requires present-Origin
  // exact-match. Scoping the relaxation to these two named routes (rather
  // than to the HTTP method) keeps it exactly at the two spec-named
  // endpoints (§7.1 step 2, addressing the authorization-scope-drift risk).
  const extGuardGetReadOnly = buildExtensionGuard(deps, { allowOriginAbsent: true })
  const extGuard = buildExtensionGuard(deps, { allowOriginAbsent: false })

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
  // Catch `express.json()`'s parse error so body-parser errors return a
  // documented envelope rather than Express' default error response,
  // which can be HTML and — in development — carry a stack trace / paths
  // on this pre-token route. Two cases are distinguished (§7.2.2 / R-10):
  //   - body exceeds the pre-auth cap → 413 `{ error: 'Payload too large' }`
  //     (body-parser sets `err.type === 'entity.too.large'`); the body is
  //     never fully parsed because the parser aborts the stream on overflow.
  //   - malformed JSON / other parse failure → 400 `{ error: 'Bad request' }`.
  const jsonParseErrorGate = (
    err: unknown,
    _req: Request,
    res: Response,
    next: express.NextFunction,
  ): void => {
    if (err) {
      if ((err as { type?: unknown }).type === 'entity.too.large') {
        res.status(413).json({ error: 'Payload too large' })
        return
      }
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

    // Return the launch token AND the freshly-minted per-pairing refresh
    // secret (§7.2.1 step 4 / (c1)). The extension persists the secret in
    // `chrome.storage.local` and presents it as the second factor of
    // `POST /token/refresh`; the volatile token goes to `storage.session`.
    res.json({ token: deps.getLaunchToken(), refreshSecret: result.refreshSecret })
  }
  router.post(
    '/pair',
    pairOriginGate,
    // §7.2.2 / R-10 pre-auth body-cap: `/pair` is reachable before
    // pairing-code auth, so bound the body size before parsing to close
    // the pre-auth body-parsing DoS surface. Overflow surfaces as an
    // `entity.too.large` error handled by `jsonParseErrorGate` (413).
    express.json({ limit: MAX_PRE_AUTH_BODY_SIZE }),
    jsonParseErrorGate,
    handlePair,
  )

  // --- /token/refresh (token-free, two-factor, §7.2.4 / (c1)) ---
  // A stale-token client re-fetches the current launch token here without
  // re-pairing. It is token-free (the client only has a stale token) but
  // NOT origin-only: present-Origin alone is spoofable via DNR/webRequest
  // header rewrite and KB does not use CORS (P-2), so origin-only would
  // let a different extension steal the token (the (b1) re-reject root).
  // (c1) closes this with TWO factors that must BOTH pass:
  //   (first)  present-Origin exact-match — the route is POST, so the SW
  //            always sends `Origin` (P-17); an absent / mismatched Origin
  //            is 403 (no absent-delegation path, unlike token-authed GET).
  //   (second) body `refreshSecret` timing-safe equal to the per-pairing
  //            secret minted at `/pair` — a DNR-Origin-spoofing extension
  //            cannot read the legitimate extension's storage and so is
  //            refused here even after spoofing the origin (S12 closure).
  // The pre-auth body-cap (1kb) runs BEFORE the secret check so an
  // attacker who spoofs the origin cannot force large-body parsing
  // (§7.2.2 / R-10); origin is validated first via `tokenRefreshOriginGate`
  // so a mismatched origin never parses a body at all.
  const tokenRefreshOriginGate = (req: Request, res: Response, next: express.NextFunction): void => {
    // §7.1 step 1: unpaired (incl. post-restart) → 403 fail-closed.
    const allowedExtensionId = deps.pairing.getAllowedExtensionId()
    if (allowedExtensionId === null) {
      res.status(403).json({ error: 'Extension not paired' })
      return
    }
    // First factor: present-Origin exact-match. No absent-delegation —
    // an absent Origin (empty / undefined) fails `parseExtensionOrigin`
    // and 403s, because this token-free route has no token gate to fall
    // back to (§7.2.4 / §5.3 N-3).
    const id = parseExtensionOrigin(req.headers.origin)
    if (id === null || id !== allowedExtensionId) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }
    next()
  }
  const handleTokenRefresh = (req: Request, res: Response): void => {
    // Second factor: refresh secret. `verifyRefreshSecret` is timing-safe
    // and returns false when unpaired or on any mismatch / missing field.
    const body = req.body as { refreshSecret?: unknown } | undefined
    if (!deps.pairing.verifyRefreshSecret(body?.refreshSecret)) {
      res.status(403).json({ error: 'Invalid refresh secret' })
      return
    }
    res.json({ token: deps.getLaunchToken() })
  }
  router.post(
    '/token/refresh',
    tokenRefreshOriginGate,
    // §7.2.2 / R-10 pre-auth body-cap: this token-free route parses a body
    // before the refresh-secret check, so bound the size to close the
    // pre-auth body-parsing DoS surface (shared cap with `/pair`).
    express.json({ limit: MAX_PRE_AUTH_BODY_SIZE }),
    jsonParseErrorGate,
    handleTokenRefresh,
  )

  // --- capabilities (read-only GET guard, absent-Origin allowed, §7.4) ---
  router.get('/capabilities', extGuardGetReadOnly, (_req, res) => {
    res.json(CAPABILITIES)
  })

  // --- agents (read-only GET guard, absent-Origin allowed, §6.1) ---
  router.get('/agents', extGuardGetReadOnly, (req, res) => {
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

  // Terminal 404 for unmatched paths under this namespace. Without it an
  // unmatched `/api/ext/_client/v1/*` request would `next()` out of the
  // mounted router and fall through into the broad `/api` stack, weakening
  // the isolation contract stated in this module's header (every request to
  // this namespace terminates here and never reaches the loopback `/api`
  // guard). Keeping the boundary explicit also makes the namespace robust if
  // later `/api` middleware gains side effects.
  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
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

  // §10.4 R-7: the agentId must name a real agent definition before any
  // launch side effect. Placed right after the bounded-string check and
  // before the registry/in-flight mutation (mirrors /api/sessions/new's
  // bad-input-is-4xx semantics, §7.3). An unknown agentId is a client
  // error (400 `Unknown agentId`); a definition-load failure is
  // fail-closed (500 `Internal error`) — we do NOT fall back to
  // bounded-string acceptance, so an unvalidated agentId never spawns.
  const existence = deps.checkAgentExists(agentId)
  if (existence === 'unknown') {
    res.status(400).json({ error: 'Unknown agentId' })
    return
  }
  if (existence === 'load-failed') {
    res.status(500).json({ error: 'Internal error' })
    return
  }

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

  // The ext session's `origin='extension'` is enforced SERVER-SIDE by
  // the injected delegate (it reserves `reserveOrigin(agentId,
  // 'extension')` in `startExtSession`), so any client-supplied
  // `req.body.origin` is ignored and we do NOT mutate the request body
  // here. Mutating it would be dead/misleading — the delegate never
  // reads `req.body.origin`, and a future delegate routing through
  // `handleNewSession` would hit that path's explicit `origin:
  // 'extension'` rejection rather than silently inheriting this value.
  await deps.handleExtSessionNew(req, res, { agentId, launchId: reg.launchId })
}
