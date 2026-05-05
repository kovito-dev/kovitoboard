/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `services/app-manifest.ts` — read / write / scan
 * helpers around `app/<appId>/manifest.json`.
 *
 * These tests run against the real filesystem inside a per-test
 * `mkdtempSync` directory. The helpers are thin enough that mocking
 * the `FileAccessLayer` would arguably exercise more of the test
 * harness than of the helpers themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DirectFsLayer } from '../../src/server/fs-layer'
import {
  readAppManifest,
  writeAppManifest,
  scanAppManifests,
  getAppManifestPath,
} from '../../src/server/services/app-manifest'
import type { AppManifest } from '../../src/shared/app-manifest-types'

// Stub the recipe logger so warn lines from `readAppManifest` don't
// pollute test output and can be inspected when relevant.
//
// `vi.mock` is hoisted above non-mock code in the file, so we
// declare the stub *inside* the factory and re-grab it via
// `vi.mocked()` after import. Putting the stub on the module's
// exported object keeps it accessible to assertions below.
vi.mock('../../src/server/logger', () => {
  const stub = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return { recipeLogger: stub }
})

// Resolve the stubbed logger object for use in assertions. Imported
// dynamically so it lives after the mock has registered.
import * as loggerModule from '../../src/server/logger'
const recipeLoggerStub = loggerModule.recipeLogger as unknown as {
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
}

let projectRoot: string
const fs = new DirectFsLayer()

function makeRecipeManifest(appId: string, overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    appId,
    displayName: overrides.displayName ?? appId,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    kovitoboardVersion: overrides.kovitoboardVersion ?? '0.1.0',
    source: overrides.source ?? {
      type: 'recipe',
      recipeId: 'document-viewer',
      recipeVersion: '1.0.0',
      recipeSource: 'sample',
    },
  }
}

beforeEach(() => {
  recipeLoggerStub.warn.mockClear()
  projectRoot = mkdtempSync(join(tmpdir(), 'kb-app-manifest-test-'))
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('writeAppManifest / readAppManifest', () => {
  it('round-trips a recipe-source manifest', () => {
    const manifest = makeRecipeManifest('document-viewer')
    writeAppManifest(fs, projectRoot, manifest)
    const restored = readAppManifest(fs, projectRoot, 'document-viewer')
    expect(restored).toEqual(manifest)
  })

  it('round-trips a user-creation manifest', () => {
    const manifest: AppManifest = {
      appId: 'my-notes',
      displayName: 'My Notes',
      createdAt: '2026-05-03T00:00:00.000Z',
      kovitoboardVersion: '0.1.0',
      source: {
        type: 'user-creation',
        createdViaAgent: 'kovito-concierge',
      },
    }
    writeAppManifest(fs, projectRoot, manifest)
    const restored = readAppManifest(fs, projectRoot, 'my-notes')
    expect(restored).toEqual(manifest)
  })

  it('creates the app/<appId>/ directory if missing', () => {
    const manifest = makeRecipeManifest('todo')
    writeAppManifest(fs, projectRoot, manifest)
    // The file should exist at the canonical path.
    expect(fs.existsSync(getAppManifestPath(projectRoot, 'todo'))).toBe(true)
  })
})

describe('readAppManifest — best-effort failure modes', () => {
  it('returns null when the file does not exist', () => {
    expect(readAppManifest(fs, projectRoot, 'ghost')).toBeNull()
    expect(recipeLoggerStub.warn).not.toHaveBeenCalled()
  })

  it('returns null with a warn when the file is not valid JSON', () => {
    mkdirSync(join(projectRoot, 'app', 'broken-json'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'app', 'broken-json', 'manifest.json'),
      'not json {',
    )
    expect(readAppManifest(fs, projectRoot, 'broken-json')).toBeNull()
    expect(recipeLoggerStub.warn).toHaveBeenCalled()
  })

  it('returns null with a warn when the JSON does not match the schema', () => {
    mkdirSync(join(projectRoot, 'app', 'bad-shape'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'app', 'bad-shape', 'manifest.json'),
      JSON.stringify({ appId: 'bad-shape' }), // missing displayName etc.
    )
    expect(readAppManifest(fs, projectRoot, 'bad-shape')).toBeNull()
    expect(recipeLoggerStub.warn).toHaveBeenCalled()
  })

  it('rejects a manifest whose source.type is unknown', () => {
    mkdirSync(join(projectRoot, 'app', 'weird-source'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'app', 'weird-source', 'manifest.json'),
      JSON.stringify({
        appId: 'weird-source',
        displayName: 'Weird',
        createdAt: '2026-05-03T00:00:00.000Z',
        kovitoboardVersion: '0.1.0',
        source: { type: 'something-else', extra: 'data' },
      }),
    )
    expect(readAppManifest(fs, projectRoot, 'weird-source')).toBeNull()
    expect(recipeLoggerStub.warn).toHaveBeenCalled()
  })
})

describe('scanAppManifests', () => {
  it('returns an empty array when app/ does not exist', () => {
    expect(scanAppManifests(fs, projectRoot)).toEqual([])
  })

  it('returns every readable manifest and skips unreadable ones', () => {
    // Two well-formed manifests…
    writeAppManifest(fs, projectRoot, makeRecipeManifest('doc'))
    writeAppManifest(fs, projectRoot, makeRecipeManifest('todo'))
    // …and one broken sibling that should be silently skipped.
    mkdirSync(join(projectRoot, 'app', 'broken'), { recursive: true })
    writeFileSync(join(projectRoot, 'app', 'broken', 'manifest.json'), 'not json')
    // Plus a bare app subdir without any manifest at all.
    mkdirSync(join(projectRoot, 'app', 'no-manifest'), { recursive: true })

    const out = scanAppManifests(fs, projectRoot)
    const ids = out.map((m) => m.appId).sort()
    expect(ids).toEqual(['doc', 'todo'])
  })
})
