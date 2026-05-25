/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * T-3-1 regression — `recipe.yaml` MUST NOT be allowed to declare
 * `trustLevel`. The authoritative source of `RecipeManifest.trustLevel`
 * is server-controlled (KovitoHub signature, sideload assignment,
 * grandfather migration). If a recipe author could declare it in
 * the YAML, a malicious recipe could pose as `'code-trusted'`
 * (green badge) and bypass the visual trust signal.
 *
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §8.2 (T-3-1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Stub the recipe logger so the parser's `warn` line on the
// rejection path does not fail in the lazy-proxy backed pino root.
// Mirrors the pattern in `recipe-parser-recipe-id.test.ts`.
const recipeLoggerStub = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../../src/server/logger', () => ({
  recipeLogger: recipeLoggerStub,
}))

import { parseRecipe } from '../../src/server/recipe-parser'
import { DirectFsLayer } from '../../src/server/fs-layer'

const fs = new DirectFsLayer()

function writeArtifact(dir: string): void {
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(
    join(dir, 'pages', 'Index.tsx'),
    'export default () => null\n',
    'utf-8',
  )
}

const BASE_HEADER = `---
recipeId: trust-forge-test
name: Trust Forge Test
description: trust marker forgery defence fixture
version: 1.0.0
artifacts:
  - path: pages/Index.tsx
    type: page
`

const FOOTER = `---
`

describe('recipe-parser rejects author-declared trustLevel (T-3-1)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kb-trustforge-'))
    writeArtifact(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('throws when recipe.yaml declares trustLevel: code-trusted', () => {
    writeFileSync(
      join(tempDir, 'recipe.yaml'),
      BASE_HEADER + "trustLevel: 'code-trusted'\n" + FOOTER,
      'utf-8',
    )
    expect(() => parseRecipe(tempDir, fs)).toThrowError(/must not declare "trustLevel"/)
  })

  it('throws even when the declared value is the otherwise-legal grandfather literal', () => {
    // Defence-in-depth: even `'unknown'` (which is what the install
    // path eventually persists) is rejected so the only authority
    // for the field stays on the server side.
    writeFileSync(
      join(tempDir, 'recipe.yaml'),
      BASE_HEADER + "trustLevel: 'unknown'\n" + FOOTER,
      'utf-8',
    )
    expect(() => parseRecipe(tempDir, fs)).toThrowError(/must not declare "trustLevel"/)
  })

  it('throws even when the declared value is a non-string forgery (boolean / number)', () => {
    // Any presence of the key — regardless of value type — counts as
    // a forgery attempt. The parser refuses before any value-shape
    // validation so a type-coercion bug downstream cannot reopen the
    // attack surface.
    writeFileSync(
      join(tempDir, 'recipe.yaml'),
      BASE_HEADER + 'trustLevel: true\n' + FOOTER,
      'utf-8',
    )
    expect(() => parseRecipe(tempDir, fs)).toThrowError(/must not declare "trustLevel"/)
  })

  it('accepts recipes that do NOT declare trustLevel (negative control)', () => {
    writeFileSync(
      join(tempDir, 'recipe.yaml'),
      BASE_HEADER + FOOTER,
      'utf-8',
    )
    const recipe = parseRecipe(tempDir, fs)
    expect(recipe.metadata.recipeId).toBe('trust-forge-test')
  })
})
