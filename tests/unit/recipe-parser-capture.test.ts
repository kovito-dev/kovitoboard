/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the `capture:` block of recipe.yaml introduced in v0.2.0
 * (Phase 1 prompt-injection ①). Mirrors the existing parser test
 * structure: build a minimal recipe directory in `mkdtempSync`, drive
 * `parseRecipe`, assert on the returned `capture` field.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRecipe } from '../../src/server/recipe-parser'
import { DirectFsLayer } from '../../src/server/fs-layer'

const fs = new DirectFsLayer()

function writeRecipeYaml(dir: string, body: string): void {
  writeFileSync(join(dir, 'recipe.yaml'), body, 'utf-8')
}

function writePlaceholderArtifact(dir: string): void {
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'pages', 'Index.tsx'), 'export default () => null\n', 'utf-8')
}

// recipe.yaml is parsed as gray-matter frontmatter — the body of the
// document is unused for directory recipes, but the `---` fences are
// still required so matter() recognises the file as frontmatter.
const BASE_HEADER = `---
recipeId: capture-test
name: Capture Test
description: capture parser fixture
version: 1.0.0
artifacts:
  - path: pages/Index.tsx
    type: page
`

const FOOTER = `---
`

describe('recipe-parser capture.requires', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kb-capture-parser-'))
    writePlaceholderArtifact(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns undefined capture when recipe.yaml omits the block', () => {
    writeRecipeYaml(tempDir, `${BASE_HEADER}${FOOTER}`)
    const parsed = parseRecipe(tempDir, fs)
    expect(parsed.capture).toBeUndefined()
  })

  it('accepts a valid capture.requires list', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture:
  requires:
    - a11y
    - exposed-context
${FOOTER}`,
    )
    const parsed = parseRecipe(tempDir, fs)
    expect(parsed.capture).toEqual({ requires: ['a11y', 'exposed-context'] })
  })

  it('refuses an unknown capture kind', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture:
  requires:
    - camera
${FOOTER}`,
    )
    expect(() => parseRecipe(tempDir, fs)).toThrow(/not a valid capture kind/)
  })

  it('refuses a duplicate capture kind', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture:
  requires:
    - a11y
    - a11y
${FOOTER}`,
    )
    expect(() => parseRecipe(tempDir, fs)).toThrow(/duplicated/)
  })

  it('refuses an empty capture.requires', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture:
  requires: []
${FOOTER}`,
    )
    expect(() => parseRecipe(tempDir, fs)).toThrow(/must not be empty/)
  })

  it('refuses a non-string capture entry', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture:
  requires:
    - 42
${FOOTER}`,
    )
    expect(() => parseRecipe(tempDir, fs)).toThrow(/must be a string/)
  })

  it('refuses a non-object capture block', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture: a11y
${FOOTER}`,
    )
    expect(() => parseRecipe(tempDir, fs)).toThrow(/capture must be an object/)
  })

  it('refuses a missing requires field', () => {
    writeRecipeYaml(
      tempDir,
      `${BASE_HEADER}
capture: {}
${FOOTER}`,
    )
    expect(() => parseRecipe(tempDir, fs)).toThrow(/capture\.requires is required/)
  })
})
