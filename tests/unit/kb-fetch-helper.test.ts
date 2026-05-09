/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
/**
 * `src/renderer/lib/kbFetch.ts` boundary tests.
 *
 * Pins:
 *   - the same-origin / `/api`-prefix filter so the launch token is
 *     never sent to a foreign destination,
 *   - the bounded-reload behaviour after a 401 (one reload, then a
 *     fatal-error overlay),
 *   - the success-path marker reset that lets a later supervisor
 *     restart recover via another reload.
 *
 * Runs in jsdom so we have a live `document`, `location`, and
 * `sessionStorage` to drive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SAMPLE_TOKEN = '0123456789abcdef0123456789abcdef'
const RELOAD_MARKER_KEY = 'kb:launch-token-reload-attempted'

function injectMetaTag(token: string): void {
  const existing = document.head.querySelector<HTMLMetaElement>('meta[name="kb-launch-token"]')
  existing?.remove()
  const meta = document.createElement('meta')
  meta.name = 'kb-launch-token'
  meta.content = token
  document.head.appendChild(meta)
}

function makeFetchMock(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl)
}

async function loadFresh(): Promise<typeof import('../../src/renderer/lib/kbFetch')> {
  vi.resetModules()
  return await import('../../src/renderer/lib/kbFetch')
}

describe('kbFetch', () => {
  let reloadMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    sessionStorage.clear()
    reloadMock = vi.fn()
    // jsdom's `location` is non-configurable, so we cannot rewrite
    // `location.reload` directly. Stubbing the whole `location`
    // object lets us intercept the call. The original origin is
    // preserved so `shouldAttachToken` (which compares request.origin
    // to location.origin) still recognises same-origin URLs.
    const original = window.location
    vi.stubGlobal('location', {
      origin: original.origin,
      protocol: original.protocol,
      host: original.host,
      hostname: original.hostname,
      port: original.port,
      reload: reloadMock,
    })
    injectMetaTag(SAMPLE_TOKEN)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('attaches the token header to a same-origin /api request', async () => {
    const { kbFetch } = await loadFresh()
    const fetchMock = makeFetchMock(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await kbFetch('/api/version')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('X-Kovitoboard-Token')).toBe(SAMPLE_TOKEN)
  })

  it('does NOT attach the token to a non-/api same-origin URL', async () => {
    const { kbFetch } = await loadFresh()
    const fetchMock = makeFetchMock(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await kbFetch('/static/foo.css')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.has('X-Kovitoboard-Token')).toBe(false)
  })

  it('does NOT attach the token to a cross-origin /api URL', async () => {
    const { kbFetch } = await loadFresh()
    const fetchMock = makeFetchMock(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await kbFetch('https://attacker.example/api/version')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.has('X-Kovitoboard-Token')).toBe(false)
  })

  it('triggers exactly one reload on the first 401 and sets the marker', async () => {
    const { kbFetch } = await loadFresh()
    const fetchMock = makeFetchMock(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    // Three concurrent in-flight 401s should still produce only one reload.
    await Promise.all([
      kbFetch('/api/version'),
      kbFetch('/api/agents'),
      kbFetch('/api/sessions'),
    ])
    // setTimeout(..., 0) batched reloads — flush microtasks + macrotask.
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(RELOAD_MARKER_KEY)).toBe('1')
  })

  it('shows a fatal-error overlay on the second 401 instead of looping', async () => {
    const { kbFetch } = await loadFresh()
    sessionStorage.setItem(RELOAD_MARKER_KEY, '1')
    const fetchMock = makeFetchMock(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await kbFetch('/api/version')
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(reloadMock).not.toHaveBeenCalled()
    expect(document.getElementById('kb-bootstrap-error')).not.toBeNull()
  })

  it('clears the reload marker after a successful response', async () => {
    const { kbFetch } = await loadFresh()
    sessionStorage.setItem(RELOAD_MARKER_KEY, '1')
    const fetchMock = makeFetchMock(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await kbFetch('/api/version')

    expect(sessionStorage.getItem(RELOAD_MARKER_KEY)).toBeNull()
  })

  it('does NOT reload on 403 (Origin allowlist failures are config bugs)', async () => {
    const { kbFetch } = await loadFresh()
    const fetchMock = makeFetchMock(async () => new Response('', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await kbFetch('/api/version')
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(reloadMock).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(RELOAD_MARKER_KEY)).toBeNull()
  })
})

describe('appendLaunchTokenQuery', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    sessionStorage.clear()
    injectMetaTag(SAMPLE_TOKEN)
  })

  it('adds ?token=<value> when the URL has no query string', async () => {
    const { appendLaunchTokenQuery } = await loadFresh()
    const result = appendLaunchTokenQuery('ws://127.0.0.1:3001/api/ws')
    expect(result).toBe(`ws://127.0.0.1:3001/api/ws?token=${SAMPLE_TOKEN}`)
  })

  it('adds &token=<value> when the URL already has a query string', async () => {
    const { appendLaunchTokenQuery } = await loadFresh()
    const result = appendLaunchTokenQuery('ws://127.0.0.1:3001/api/ws?foo=bar')
    expect(result).toBe(`ws://127.0.0.1:3001/api/ws?foo=bar&token=${SAMPLE_TOKEN}`)
  })

  it('returns the URL unchanged when no token meta tag is present', async () => {
    document.head.innerHTML = ''
    const { appendLaunchTokenQuery } = await loadFresh()
    const result = appendLaunchTokenQuery('ws://127.0.0.1:3001/api/ws')
    expect(result).toBe('ws://127.0.0.1:3001/api/ws')
  })
})

describe('shouldAttachToken (filter)', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    injectMetaTag(SAMPLE_TOKEN)
  })

  it('accepts a relative /api path', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken('/api/version')).toBe(true)
  })

  it('accepts an absolute same-origin /api URL', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken(`${location.origin}/api/version`)).toBe(true)
  })

  it('rejects a non-/api same-origin path', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken('/static/foo')).toBe(false)
  })

  it('rejects a cross-origin /api URL', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken('https://attacker.example/api/version')).toBe(false)
  })

  it('rejects a malformed URL', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken('::not-a-url::' as unknown as RequestInfo)).toBe(false)
  })

  it('rejects look-alike paths such as /apiary or /api-v2', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken('/apiary')).toBe(false)
    expect(__testing.shouldAttachToken('/api-v2/foo')).toBe(false)
    expect(__testing.shouldAttachToken('/apiv2')).toBe(false)
  })

  it('accepts the /api root exactly and any /api/<sub> path', async () => {
    const { __testing } = await loadFresh()
    expect(__testing.shouldAttachToken('/api')).toBe(true)
    expect(__testing.shouldAttachToken('/api/')).toBe(true)
    expect(__testing.shouldAttachToken('/api/admin/restart')).toBe(true)
  })
})
