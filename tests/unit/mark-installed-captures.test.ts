/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Validator tests for the v0.2.0 `approvedCaptures` field in
 * `POST /api/recipes/:recipeId/mark-installed` (recipe-system.md
 * v1.4 §6.10.2). The pre-existing scope / api validations live in
 * the broader mark-installed test, so this file focuses on the new
 * capture-specific paths.
 */
import { describe, expect, it } from 'vitest'
import {
  validateMarkInstalledRequest,
  type MarkInstalledBody,
} from '../../src/server/recipe/markInstalledValidator'

const RECIPE_ID = 'capture-recipe'

function validBody(
  override: Partial<MarkInstalledBody> = {},
): Record<string, unknown> {
  return {
    appId: 'capture-app',
    approvedScopes: ['own-data'],
    approvedCaptures: ['a11y'],
    recipeVersion: '1.0.0',
    recipeSource: 'sample',
    recipeHash: 'deadbeef',
    installNonce: 'a'.repeat(32),
    ...override,
  }
}

describe('validateMarkInstalledRequest — approvedCaptures', () => {
  it('accepts a valid approvedCaptures array', () => {
    const result = validateMarkInstalledRequest(RECIPE_ID, validBody())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.approvedCaptures).toEqual(['a11y'])
    }
  })

  it('accepts an empty approvedCaptures array', () => {
    // The user-declined-everything case is legitimate and must be
    // sent explicitly. A 400 on empty would force the agent to
    // synthesise a default value, which would silently widen the
    // approved set.
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({ approvedCaptures: [] }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.approvedCaptures).toEqual([])
    }
  })

  it('defaults to an empty approvedCaptures array when the field is missing', () => {
    // The L1 fake-claude harness predates the v0.2.0 capture surface
    // and still sends the legacy body shape. Treating missing as ""
    // capture all-refused" keeps the grandfather coverage suite from
    // breaking while still letting the v0.3.0 install dialog send
    // the field explicitly. See markInstalledValidator's comment
    // block for the rationale.
    const body = validBody()
    delete (body as Record<string, unknown>).approvedCaptures
    const result = validateMarkInstalledRequest(RECIPE_ID, body)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.approvedCaptures).toEqual([])
    }
  })

  it('refuses approvedCaptures with an unknown kind', () => {
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({ approvedCaptures: ['camera' as never] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/approvedCaptures/)
    }
  })

  it('refuses approvedCaptures with a non-array value', () => {
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({ approvedCaptures: 'a11y' as unknown as never[] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }
  })
})
