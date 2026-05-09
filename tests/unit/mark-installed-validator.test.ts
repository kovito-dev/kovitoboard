/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `validateMarkInstalledRequest` — the body validator
 * for `POST /api/recipes/:recipeId/mark-installed`.
 *
 * The validator returns a discriminated union so the route handler
 * can map directly to a 4xx response or proceed with a typed body.
 *
 * @see docs/specs/v0.1.0-recipe-install-handover.md §3.3
 */
import { describe, expect, it } from 'vitest'
import { validateMarkInstalledRequest } from '../../src/server/recipe/markInstalledValidator'

// Same hex shape as KB_LAUNCH_TOKEN — 32 lowercase hex characters.
const VALID_NONCE = '0123456789abcdef0123456789abcdef'

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: 'document-viewer',
    approvedScopes: ['project-read', 'own-data'],
    recipeVersion: '1.1.0',
    recipeSource: 'sample',
    recipeHash: 'sha256:abc',
    installNonce: VALID_NONCE,
    ...overrides,
  }
}

describe('validateMarkInstalledRequest', () => {
  it('accepts a minimal valid request without an api section', () => {
    const result = validateMarkInstalledRequest('document-viewer', baseBody())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.appId).toBe('document-viewer')
      expect(result.value.approvedScopes).toEqual(['project-read', 'own-data'])
      expect(result.value.recipeVersion).toBe('1.1.0')
      expect(result.value.recipeSource).toBe('sample')
      expect(result.value.recipeHash).toBe('sha256:abc')
      expect(result.value.api).toBeUndefined()
    }
  })

  it('accepts a request with a valid api section', () => {
    const result = validateMarkInstalledRequest(
      'todo-manager',
      baseBody({
        api: {
          scopes: ['project-read', 'own-data'],
          calls: [
            { id: 'list-todos', handler: 'list-files', args: { path: 'todo/' } },
          ],
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.api?.calls[0]?.id).toBe('list-todos')
      expect(result.value.api?.scopes).toEqual(['project-read', 'own-data'])
    }
  })

  it('accepts complex recipeId path parameters (slashes, dots, @)', () => {
    const ok = validateMarkInstalledRequest('kovito-dev/document-viewer@1.0.0', baseBody())
    expect(ok.ok).toBe(true)
  })

  it('rejects a malformed recipeId path parameter with 404', () => {
    const result = validateMarkInstalledRequest('with spaces', baseBody())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('rejects a non-string recipeId with 404', () => {
    const result = validateMarkInstalledRequest(undefined, baseBody())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('rejects a non-object body with 400', () => {
    const result = validateMarkInstalledRequest('todo-manager', 'not a json object')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects an appId that violates the slug pattern', () => {
    const result = validateMarkInstalledRequest(
      'todo-manager',
      baseBody({ appId: 'Capitalized' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('appId')
    }
  })

  it('rejects an appId longer than 64 characters', () => {
    const longId = 'a' + 'b'.repeat(64)
    const result = validateMarkInstalledRequest('todo', baseBody({ appId: longId }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects approvedScopes that contain unknown scope names', () => {
    const result = validateMarkInstalledRequest(
      'todo',
      baseBody({ approvedScopes: ['project-read', 'wat-is-this'] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('approvedScopes')
    }
  })

  it('rejects approvedScopes that is not an array', () => {
    const result = validateMarkInstalledRequest(
      'todo',
      baseBody({ approvedScopes: 'project-read' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects an empty recipeVersion', () => {
    const result = validateMarkInstalledRequest('todo', baseBody({ recipeVersion: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('recipeVersion')
  })

  it('rejects an unsupported recipeSource', () => {
    const result = validateMarkInstalledRequest(
      'todo',
      baseBody({ recipeSource: 'kovitohub' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('recipeSource')
  })

  it('rejects an empty recipeHash', () => {
    const result = validateMarkInstalledRequest('todo', baseBody({ recipeHash: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('recipeHash')
  })

  it('rejects an api section with an unknown handler', () => {
    const result = validateMarkInstalledRequest(
      'todo',
      baseBody({
        api: {
          scopes: ['project-read'],
          calls: [{ id: 'foo', handler: 'wat-is-this' }],
        },
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Invalid api section')
  })

  it('rejects when installNonce is missing', () => {
    const body = baseBody()
    delete body.installNonce
    const result = validateMarkInstalledRequest('document-viewer', body)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/installNonce/)
    }
  })

  it('rejects when installNonce is shorter than 32 hex chars', () => {
    const result = validateMarkInstalledRequest(
      'document-viewer',
      baseBody({ installNonce: 'abc123' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }
  })

  it('rejects when installNonce contains uppercase hex (non-canonical)', () => {
    const result = validateMarkInstalledRequest(
      'document-viewer',
      baseBody({ installNonce: VALID_NONCE.toUpperCase() }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }
  })

  it('rejects when installNonce contains non-hex characters', () => {
    const result = validateMarkInstalledRequest(
      'document-viewer',
      baseBody({ installNonce: '0123456789abcdef0123456789abcdez' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }
  })

  it('treats null api as "no api section"', () => {
    const result = validateMarkInstalledRequest('todo', baseBody({ api: null }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.api).toBeUndefined()
  })
})
