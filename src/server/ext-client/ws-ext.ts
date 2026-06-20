/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * External-client WebSocket integration (external-client-api.md v1.0
 * §7.5 / §7.6.2 / §8.4).
 *
 * Responsibilities:
 *   - Classify each upgrade as `extension` / `renderer` / `reject`
 *     (3-value, §7.6.2). The `ws` `verifyClient` callback can only
 *     accept / reject, so the final classification is re-evaluated in
 *     the `connection` handler from `request.headers.origin` and stored
 *     in a per-socket metadata map.
 *   - Track per-extension-connection subscription sets (§7.5).
 *   - Decide, per outbound event, whether an extension connection
 *     should receive it (subscription + launchId-scope filtering). The
 *     renderer broadcast path is unchanged (full fan-out).
 *
 * This module touches NEITHER `originAllowed()` NOR the existing
 * renderer broadcast behaviour: renderer connections keep receiving the
 * full unfiltered stream (INV / P-11 regression-safe). Only extension
 * connections are filtered.
 */
import type { WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { parseExtensionOrigin } from '../middleware/ext-origin'
import type { PairingStore } from './pairing-store'

/** ext API major version this KB build speaks (§7.6.2). */
export const EXT_API_VERSION = 1

export type ConnectionKind = 'extension' | 'renderer'

interface ExtConnectionMeta {
  kind: ConnectionKind
  /** Monotonic per-connection id (correlates HTTP-less launch echo). */
  connId: number
  /** sessionIds this extension connection is subscribed to (§7.5). */
  subscriptions: Set<string>
}

/**
 * Per-socket metadata + subscription tracking for extension WS
 * connections. Renderer connections are recorded with an empty
 * subscription set and `kind='renderer'` so the broadcast filter can
 * special-case them to full fan-out.
 */
export class ExtWsConnections {
  private meta = new WeakMap<WebSocket, ExtConnectionMeta>()
  /** Live extension sockets, indexed by connId, for targeted sends. */
  private extByConnId = new Map<number, WebSocket>()
  private nextConnId = 1

  /** Register a freshly-connected socket with its classified kind. */
  register(ws: WebSocket, kind: ConnectionKind): number {
    const connId = this.nextConnId++
    this.meta.set(ws, { kind, connId, subscriptions: new Set() })
    if (kind === 'extension') this.extByConnId.set(connId, ws)
    return connId
  }

  /** Tear down per-connection state on socket close. */
  unregister(ws: WebSocket): void {
    const m = this.meta.get(ws)
    if (m && m.kind === 'extension') this.extByConnId.delete(m.connId)
    this.meta.delete(ws)
  }

  isExtension(ws: WebSocket): boolean {
    return this.meta.get(ws)?.kind === 'extension'
  }

  getConnId(ws: WebSocket): number | null {
    return this.meta.get(ws)?.connId ?? null
  }

  /** Add a sessionId to a connection's subscription set (idempotent). */
  subscribe(ws: WebSocket, sessionId: string): void {
    this.meta.get(ws)?.subscriptions.add(sessionId)
  }

  /** Auto-subscribe the originating connection by connId (§7.3.1 4b). */
  subscribeByConnId(connId: number, sessionId: string): void {
    const ws = this.extByConnId.get(connId)
    if (ws) this.meta.get(ws)?.subscriptions.add(sessionId)
  }

  isSubscribed(ws: WebSocket, sessionId: string): boolean {
    return this.meta.get(ws)?.subscriptions.has(sessionId) ?? false
  }

  /** All live extension sockets (for same-extension HTTP-new echo). */
  extensionSockets(): WebSocket[] {
    return Array.from(this.extByConnId.values())
  }

  /** The socket for a given connId, if still live. */
  socketByConnId(connId: number): WebSocket | undefined {
    return this.extByConnId.get(connId)
  }
}

/**
 * Re-evaluate an upgrade request's origin against the live pairing
 * state to produce the final 3-value classification (§7.6.2). Returns
 * `'reject'` for an origin that is neither a loopback renderer nor the
 * currently-paired extension (e.g. a stale extension origin after a
 * re-pairing TOCTOU) — the caller must close such a socket rather than
 * silently treating it as a renderer.
 */
export function classifyConnection(
  origin: string | undefined,
  pairing: PairingStore,
  isLoopbackOrigin: (origin: string | undefined) => boolean,
): ConnectionKind | 'reject' {
  const allowedExtensionId = pairing.getAllowedExtensionId()
  if (allowedExtensionId !== null) {
    const id = parseExtensionOrigin(origin)
    if (id !== null && id === allowedExtensionId) return 'extension'
    // A valid-but-unmatched extension origin is a reject (not a
    // renderer): it must not be silently promoted to the full-fan-out
    // renderer class.
    if (id !== null) return 'reject'
  }
  if (isLoopbackOrigin(origin)) return 'renderer'
  return 'reject'
}

/** `ws` verifyClient callback signature. */
type VerifyCb = (verified: boolean, code?: number, message?: string) => void
type VerifyInfo = { origin: string; req: IncomingMessage; secure: boolean }

/**
 * Build an ext-aware `verifyClient` (§7.6.2). For a paired extension
 * origin it requires the launch token (query) AND `extApiVersion`
 * matching the KB major; otherwise it delegates to the existing
 * renderer verifier verbatim, so loopback / renderer behaviour is
 * unchanged (INV / P-8 regression-safe).
 *
 * @param rendererVerify the existing `createWsClientVerifier` instance.
 * @param expectedToken  the per-launch token (rotation-aware caller may
 *                       capture it; Phase 0 token is per-launch constant).
 * @param tokensMatch    canonical timing-safe token compare.
 */
export function createExtAwareWsVerifier(args: {
  pairing: PairingStore
  rendererVerify: (info: VerifyInfo, cb: VerifyCb) => void
  getLaunchToken: () => string
  tokensMatch: (actual: string | undefined, expected: string) => boolean
}): (info: VerifyInfo, cb: VerifyCb) => void {
  return function verifyClient(info: VerifyInfo, cb: VerifyCb): void {
    const allowedExtensionId = args.pairing.getAllowedExtensionId()
    const extId = parseExtensionOrigin(info.origin)

    // Not an extension origin → existing renderer path (unchanged).
    if (extId === null) {
      args.rendererVerify(info, cb)
      return
    }

    // Extension origin but not paired / id mismatch → reject (§7.6.2,
    // fail-closed). Never fall through to the renderer verifier (which
    // would 403 anyway, but we want the explicit extension reject path).
    if (allowedExtensionId === null || extId !== allowedExtensionId) {
      cb(false, 403, 'Origin not allowed')
      return
    }

    // Token (query) check — same material as the renderer path.
    const queryToken = parseQueryToken(info.req)
    if (!args.tokensMatch(queryToken, args.getLaunchToken())) {
      cb(false, 401, 'Authentication required')
      return
    }

    // extApiVersion negotiation: must equal the KB major (§7.6.2).
    const version = parseExtApiVersion(info.req)
    if (version !== EXT_API_VERSION) {
      cb(false, 400, 'Unsupported extApiVersion')
      return
    }

    cb(true)
  }
}

function parseQueryToken(req: IncomingMessage): string | undefined {
  const rawUrl = req.url ?? ''
  const q = rawUrl.indexOf('?')
  if (q < 0) return undefined
  const params = new URLSearchParams(rawUrl.slice(q + 1))
  return params.get('token') ?? undefined
}

/**
 * Parse the `extApiVersion` query param from a WS upgrade URL. Returns
 * `null` when absent / unparseable.
 */
export function parseExtApiVersion(req: IncomingMessage): number | null {
  const rawUrl = req.url ?? ''
  const q = rawUrl.indexOf('?')
  if (q < 0) return null
  const params = new URLSearchParams(rawUrl.slice(q + 1))
  const raw = params.get('extApiVersion')
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}
