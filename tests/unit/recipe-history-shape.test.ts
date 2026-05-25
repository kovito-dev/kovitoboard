/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the `RecipeHistoryEntry` JSONL round-trip and the
 * `appId` field that v0.2.0 promotes to a first-class member.
 *
 * Pinned behaviour:
 *   - install entries written from v0.2.0 onward carry `appId` and
 *     it survives a write -> read round-trip (no shape coercion).
 *   - install entries written by v0.1.x (no `appId`) still parse
 *     cleanly — `appId` is optional so the runtime guard accepts
 *     them and `appId` reads back as `undefined`.
 *   - mixing both shapes in the same JSONL file does not lose any
 *     entries.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  appendRecipeHistory,
  readRecipeHistory,
  getRecipeHistoryPath,
} from '../../src/server/recipe-history'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { _resetProjectRootCache } from '../../src/server/config'
import type { RecipeHistoryEntry } from '../../src/shared/recipe-types'

let tmpDir: string

const fsLayer = new DirectFsLayer()

beforeEach(() => {
  // Each test gets its own project root so the JSONL writer does not
  // pick up a stale file from a previous run. `resolveProjectRoot`
  // memoises the result on first call, so we have to reset the cache
  // after pointing the env var at the new tmp tree.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-history-shape-'))
  process.env.KOVITOBOARD_PROJECT_ROOT = tmpDir
  _resetProjectRootCache()
  fs.mkdirSync(path.join(tmpDir, '.kovitoboard'), { recursive: true })
})

afterEach(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
  _resetProjectRootCache()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeInstallEntry(
  overrides: Partial<RecipeHistoryEntry>,
): RecipeHistoryEntry {
  return {
    id: overrides.id ?? 'r_20260510_001',
    action: 'install',
    name: overrides.name ?? 'todo-manager',
    version: overrides.version ?? '1.0.0',
    source: overrides.source ?? 'sample',
    hash: overrides.hash ?? 'sha256:abc',
    appliedAt: overrides.appliedAt ?? '2026-05-10T00:00:00.000Z',
    artifacts: overrides.artifacts ?? [],
    menu: overrides.menu ?? [],
    recipeId: overrides.recipeId ?? 'todo-manager',
    ...overrides,
  }
}

describe('RecipeHistoryEntry — appId first-class field round-trip', () => {
  it('persists appId on install entries written from v0.2.0', () => {
    const entry = makeInstallEntry({ appId: 'my-todo-app' })
    appendRecipeHistory(fsLayer, entry)

    const read = readRecipeHistory(fsLayer)
    expect(read).toHaveLength(1)
    expect(read[0].appId).toBe('my-todo-app')
    // The entry as a whole survives the round trip, not just appId.
    expect(read[0]).toMatchObject({
      id: entry.id,
      action: 'install',
      recipeId: entry.recipeId,
      appId: 'my-todo-app',
    })
  })

  it('accepts legacy install entries that omit appId', () => {
    // Pre-v0.2.0 install entries did not carry appId. They go
    // through `appendRecipeHistory` unchanged, and `readRecipeHistory`
    // returns them with appId === undefined rather than rejecting
    // them as malformed.
    const legacyEntry = makeInstallEntry({ id: 'r_legacy', appId: undefined })
    appendRecipeHistory(fsLayer, legacyEntry)

    const read = readRecipeHistory(fsLayer)
    expect(read).toHaveLength(1)
    expect(read[0].id).toBe('r_legacy')
    expect(read[0].appId).toBeUndefined()
  })

  it('does not lose entries when appId-bearing and legacy rows mix', () => {
    // Order: legacy install -> v0.2.0 install -> uninstall referencing
    // recipeId only (legacy uninstall shape stays valid).
    appendRecipeHistory(
      fsLayer,
      makeInstallEntry({ id: 'r_legacy', appId: undefined }),
    )
    appendRecipeHistory(
      fsLayer,
      makeInstallEntry({ id: 'r_modern', appId: 'todo-app-2' }),
    )
    appendRecipeHistory(fsLayer, {
      id: 'r_uninstall',
      action: 'uninstall',
      name: 'todo-manager',
      version: '1.0.0',
      source: 'sample',
      hash: 'sha256:abc',
      appliedAt: '2026-05-10T01:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: 'todo-manager',
      ownDataDeleted: false,
    })

    const read = readRecipeHistory(fsLayer)
    expect(read.map((e) => e.id)).toEqual([
      'r_legacy',
      'r_modern',
      'r_uninstall',
    ])
    expect(read[0].appId).toBeUndefined()
    expect(read[1].appId).toBe('todo-app-2')
    expect(read[2].action).toBe('uninstall')
  })

  it('keeps the JSONL file at the canonical path so log tooling stays aligned', () => {
    appendRecipeHistory(fsLayer, makeInstallEntry({ appId: 'app-1' }))
    const expectedPath = getRecipeHistoryPath(fsLayer)
    expect(fs.existsSync(expectedPath)).toBe(true)
    // One line + trailing newline; ensures appendFileSync is still
    // the writer (rather than a lossy read-modify-write rewriter).
    const raw = fs.readFileSync(expectedPath, 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })
})
