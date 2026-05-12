/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Validator tests for the v0.2.0 capture fields in
 * `POST /api/recipes/:recipeId/mark-installed` (recipe-system.md
 * v1.5 §6.10.2 / §6.10.3). v1.5 introduces the `captureRequires`
 * body field alongside `approvedCaptures` and the I-CR1 invariant
 * (`approvedCaptures ⊆ captureRequires`); the pre-existing scope /
 * api validations live in the broader mark-installed test, so this
 * file focuses on the capture-specific paths.
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
    captureRequires: ['a11y'],
    approvedCaptures: ['a11y'],
    recipeVersion: '1.0.0',
    recipeSource: 'sample',
    recipeHash: 'deadbeef',
    installNonce: 'a'.repeat(32),
    ...override,
  }
}

describe('validateMarkInstalledRequest — capture fields (v1.5)', () => {
  it('accepts a valid (captureRequires + approvedCaptures) pair', () => {
    const result = validateMarkInstalledRequest(RECIPE_ID, validBody())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.captureRequires).toEqual(['a11y'])
      expect(result.value.approvedCaptures).toEqual(['a11y'])
    }
  })

  it('accepts captureRequires with a strict subset of approvedCaptures', () => {
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({
        captureRequires: ['a11y', 'exposed-context'],
        approvedCaptures: ['a11y'],
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.captureRequires).toEqual(['a11y', 'exposed-context'])
      expect(result.value.approvedCaptures).toEqual(['a11y'])
    }
  })

  it('accepts an empty approvedCaptures array when captureRequires is also empty', () => {
    // The user-declined-everything case is legitimate and must be
    // sent explicitly. A 400 on empty would force the agent to
    // synthesise a default value, which would silently widen the
    // approved set.
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({ captureRequires: [], approvedCaptures: [] }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.captureRequires).toEqual([])
      expect(result.value.approvedCaptures).toEqual([])
    }
  })

  it('rejects with I_CR1_VIOLATION when approvedCaptures is not a subset of captureRequires', () => {
    // The classic tamper attempt: approve a kind that the recipe
    // never declared. Validator must refuse the body 400 with the
    // explicit error code so the mark-installed handler can surface
    // it to the agent.
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({
        captureRequires: ['exposed-context'],
        approvedCaptures: ['a11y'],
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/I_CR1_VIOLATION/)
    }
  })

  it('defaults to empty arrays when both fields are missing', () => {
    // The L1 fake-claude harness predates the v0.2.0 capture surface
    // and still sends the legacy body shape. Treating both as
    // "capture all-refused" keeps the grandfather coverage suite
    // from breaking while still letting the v0.3.0 install dialog
    // send the fields explicitly. See markInstalledValidator's
    // comment block for the rationale.
    const body = validBody()
    delete (body as Record<string, unknown>).captureRequires
    delete (body as Record<string, unknown>).approvedCaptures
    const result = validateMarkInstalledRequest(RECIPE_ID, body)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.captureRequires).toEqual([])
      expect(result.value.approvedCaptures).toEqual([])
    }
  })

  it('refuses captureRequires with an unknown kind', () => {
    const result = validateMarkInstalledRequest(
      RECIPE_ID,
      validBody({ captureRequires: ['camera' as never] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/captureRequires/)
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
