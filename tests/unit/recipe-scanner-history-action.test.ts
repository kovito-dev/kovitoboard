/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `findHistoryMatch` — the recipeId-keyed lookup the
 * recipe scanner uses to compute the `installed` flag exposed by
 * `GET /api/recipes/sample`.
 *
 * v2.0 pinned behavior (DEC-024 D-4-b):
 *   - The lookup key is the recipe author's `recipeId`, not the
 *     legacy `name` field. Legacy history entries (no `recipeId`)
 *     are matched via `kebab-case(entry.name)`.
 *   - **Uninstall entries are ignored.** Once a recipe has been
 *     installed at least once, `findHistoryMatch` returns the
 *     matching install entry forever, so the sample card stays in
 *     the "installed" lane and the reinstall button keeps appearing.
 *   - Hash matches take priority over recipeId-only matches.
 *   - Action-less legacy entries continue to count as installs.
 */
import { describe, expect, it } from 'vitest'
import { findHistoryMatch } from '../../src/server/services/recipe-scanner'
import type { RecipeHistoryEntry } from '../../src/shared/recipe-types'

function makeEntry(overrides: Partial<RecipeHistoryEntry>): RecipeHistoryEntry {
  return {
    id: overrides.id ?? 'r_x',
    name: overrides.name ?? 'TODO Manager',
    version: overrides.version ?? '1.0.0',
    source: overrides.source ?? '',
    hash: overrides.hash ?? 'h-1',
    appliedAt: overrides.appliedAt ?? '2026-05-03T00:00:00.000Z',
    artifacts: overrides.artifacts ?? ['pages/TodoPage.tsx'],
    menu: overrides.menu ?? ['todo'],
    recipeId: overrides.recipeId ?? 'todo-manager',
    ...overrides,
  }
}

describe('findHistoryMatch (recipeId-keyed, uninstall-ignored)', () => {
  it('returns the install entry when only an install record exists', () => {
    const history = [makeEntry({ id: 'r_1', action: 'install' })]
    const match = findHistoryMatch(history, 'todo-manager', 'h-1')
    expect(match?.id).toBe('r_1')
  })

  it('treats action-less legacy entries as installs (backward compat)', () => {
    // Pre-uninstall builds wrote no `action` field. Those entries
    // must keep counting as installs so users do not see their
    // pre-existing recipes flip to "available" after an upgrade.
    const history = [makeEntry({ id: 'r_legacy' })]
    const match = findHistoryMatch(history, 'todo-manager', 'h-1')
    expect(match?.id).toBe('r_legacy')
  })

  it('keeps returning the install entry even when the latest record is an uninstall', () => {
    // v2.0 contract: uninstall records are ignored on the recipe
    // sample card so that the reinstall button stays available.
    const history = [
      makeEntry({ id: 'r_1', action: 'install' }),
      makeEntry({
        id: 'r_2',
        action: 'uninstall',
        appliedAt: '2026-05-03T01:00:00.000Z',
      }),
    ]
    const match = findHistoryMatch(history, 'todo-manager', 'h-1')
    expect(match?.id).toBe('r_1')
  })

  it('returns the most recent install when the user has reinstalled after uninstalling', () => {
    const history = [
      makeEntry({ id: 'r_1', action: 'install' }),
      makeEntry({ id: 'r_2', action: 'uninstall', appliedAt: '2026-05-03T01:00:00.000Z' }),
      makeEntry({ id: 'r_3', action: 'install', appliedAt: '2026-05-03T02:00:00.000Z' }),
    ]
    const match = findHistoryMatch(history, 'todo-manager', 'h-1')
    expect(match?.id).toBe('r_3')
  })

  it('prefers an exact hash match over a recipeId-only match', () => {
    // The same recipeId has two install entries with different
    // hashes (e.g. the user upgraded the version). The exact-hash
    // install should win when its hash matches the lookup hash.
    const history = [
      makeEntry({ id: 'r_old', hash: 'h-1', version: '1.0.0', action: 'install' }),
      makeEntry({ id: 'r_new', hash: 'h-2', version: '1.1.0', action: 'install' }),
    ]
    const match = findHistoryMatch(history, 'todo-manager', 'h-2')
    expect(match?.id).toBe('r_new')
  })

  it('falls back to a recipeId-only match when no hash matches', () => {
    const history = [
      makeEntry({ id: 'r_v0', hash: 'h-old', version: '1.0.0', action: 'install' }),
    ]
    const match = findHistoryMatch(history, 'todo-manager', 'h-current')
    expect(match?.id).toBe('r_v0')
  })

  it('returns the install entry even when an uninstall is the latest recipeId-only match', () => {
    // Different from v1.x: uninstall is ignored and the install is
    // still surfaced.
    const history = [
      makeEntry({ id: 'r_v0', hash: 'h-old', version: '1.0.0', action: 'install' }),
      makeEntry({
        id: 'r_v0_un',
        hash: 'h-old',
        action: 'uninstall',
        appliedAt: '2026-05-03T01:00:00.000Z',
      }),
    ]
    const match = findHistoryMatch(history, 'todo-manager', 'h-current')
    expect(match?.id).toBe('r_v0')
  })

  it('matches legacy entries that lack a `recipeId` field via kebab-cased name', () => {
    // Pre-DEC-024 entries did not write the recipeId field. The
    // scanner derives the recipeId from the kebab-cased name so the
    // legacy install keeps showing up in the installed lane.
    const history = [
      makeEntry({
        id: 'r_legacy',
        name: 'TODO Manager',
        recipeId: undefined,
        action: 'install',
      }),
    ]
    const match = findHistoryMatch(history, 'todo-manager', 'h-1')
    expect(match?.id).toBe('r_legacy')
  })

  it('does not match a different recipeId', () => {
    const history = [makeEntry({ id: 'r_1', recipeId: 'document-viewer', action: 'install' })]
    expect(findHistoryMatch(history, 'todo-manager', 'h-1')).toBeUndefined()
  })

  it('returns undefined when no entry matches at all', () => {
    const history: RecipeHistoryEntry[] = []
    expect(findHistoryMatch(history, 'todo-manager', 'h-1')).toBeUndefined()
  })
})
