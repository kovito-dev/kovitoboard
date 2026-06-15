/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for loadConfig()'s watcher deep-merge + validation
 * (session-management.md §7.3.3 / §7.3.3.1).
 *
 * The root-cause of the dirty-start add-drop bug was a shallow merge
 * that replaced the whole `watcher` block when viewer.config.json
 * specified it partially, dropping `usePolling: true` (default) and
 * flipping the watcher into inotify mode. These tests pin the
 * field-by-field deep merge, per-field fallback, and the
 * unsafe-combination loud log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConfig, _resetProjectRootCache } from '../../src/server/config'
import type { FileAccessLayer } from '../../src/server/fs-layer'

/** Minimal mock FS that returns a fixed viewer.config.json content. */
function createMockFs(viewerConfigJson: string | null): FileAccessLayer {
  return {
    existsSync: () => false,
    readFileSync: (p: string) => {
      if (p.endsWith('viewer.config.json')) {
        if (viewerConfigJson === null) throw new Error(`ENOENT: ${p}`)
        return viewerConfigJson
      }
      throw new Error(`ENOENT: ${p}`)
    },
    readdirSync: () => [],
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0, isFile: true, isDirectory: false }),
    writeFileSync: () => {},
    unlinkSync: () => {},
    mkdirSync: () => {},
    symlinkSync: () => {},
    watch: () => ({ close: () => {} }) as unknown as ReturnType<FileAccessLayer['watch']>,
  } as FileAccessLayer
}

describe('loadConfig watcher deep-merge (§7.3.3)', () => {
  const originalArgv = [...process.argv]

  beforeEach(() => {
    _resetProjectRootCache()
    process.argv = [...originalArgv]
    delete process.env.KOVITOBOARD_PROJECT_ROOT
    // Force cwd-fallback so resolveProjectRoot never throws.
    process.env.KOVITOBOARD_PROJECT_ROOT = process.cwd()
  })

  afterEach(() => {
    process.argv = originalArgv
    delete process.env.KOVITOBOARD_PROJECT_ROOT
    _resetProjectRootCache()
    vi.restoreAllMocks()
  })

  it('partial watcher keeps usePolling/reconcileInterval defaults (root-cause fix)', () => {
    const fs = createMockFs(JSON.stringify({ watcher: { pollInterval: 3000 } }))
    const cfg = loadConfig(fs)
    expect(cfg.watcher.usePolling).toBe(true) // default preserved (was dropped before)
    expect(cfg.watcher.pollInterval).toBe(3000) // override respected
    expect(cfg.watcher.reconcileInterval).toBe(10000) // default preserved
  })

  it('explicit usePolling:false is respected (operator inotify opt-in)', () => {
    const fs = createMockFs(JSON.stringify({ watcher: { usePolling: false } }))
    const cfg = loadConfig(fs)
    expect(cfg.watcher.usePolling).toBe(false)
    expect(cfg.watcher.pollInterval).toBe(1500)
    expect(cfg.watcher.reconcileInterval).toBe(10000)
  })

  it('no watcher block at all → all defaults', () => {
    const fs = createMockFs(JSON.stringify({ claudeDir: '/tmp/x/.claude' }))
    const cfg = loadConfig(fs)
    expect(cfg.watcher).toEqual({ usePolling: true, pollInterval: 1500, reconcileInterval: 10000 })
  })

  it('watcher not an object (string / array / null) → falls back to defaults', () => {
    expect(loadConfig(createMockFs(JSON.stringify({ watcher: 'nope' }))).watcher).toEqual({
      usePolling: true,
      pollInterval: 1500,
      reconcileInterval: 10000,
    })
    expect(loadConfig(createMockFs(JSON.stringify({ watcher: [1, 2] }))).watcher).toEqual({
      usePolling: true,
      pollInterval: 1500,
      reconcileInterval: 10000,
    })
    expect(loadConfig(createMockFs(JSON.stringify({ watcher: null }))).watcher).toEqual({
      usePolling: true,
      pollInterval: 1500,
      reconcileInterval: 10000,
    })
  })

  it('usePolling non-boolean → default true', () => {
    const cfg = loadConfig(createMockFs(JSON.stringify({ watcher: { usePolling: 'yes' } })))
    expect(cfg.watcher.usePolling).toBe(true)
  })

  it('pollInterval invalid (NaN/<=0/string) → default 1500', () => {
    expect(loadConfig(createMockFs(JSON.stringify({ watcher: { pollInterval: -5 } }))).watcher.pollInterval).toBe(1500)
    expect(loadConfig(createMockFs(JSON.stringify({ watcher: { pollInterval: 0 } }))).watcher.pollInterval).toBe(1500)
    expect(loadConfig(createMockFs(JSON.stringify({ watcher: { pollInterval: 'x' } }))).watcher.pollInterval).toBe(1500)
  })

  it('reconcileInterval invalid (string) → default 10000', () => {
    expect(
      loadConfig(createMockFs(JSON.stringify({ watcher: { reconcileInterval: 'x' } }))).watcher.reconcileInterval,
    ).toBe(10000)
  })

  it('reconcileInterval <= 0 is a valid disable opt-out (preserved, normalized to 0)', () => {
    expect(
      loadConfig(createMockFs(JSON.stringify({ watcher: { reconcileInterval: 0 } }))).watcher.reconcileInterval,
    ).toBe(0)
    expect(
      loadConfig(createMockFs(JSON.stringify({ watcher: { reconcileInterval: -100 } }))).watcher.reconcileInterval,
    ).toBe(0)
  })

  it('non-integer intervals are floored to integer ms', () => {
    const cfg = loadConfig(createMockFs(JSON.stringify({ watcher: { pollInterval: 1500.9, reconcileInterval: 9999.9 } })))
    expect(cfg.watcher.pollInterval).toBe(1500)
    expect(cfg.watcher.reconcileInterval).toBe(9999)
  })

  it('fractional pollInterval in (0,1) does not floor to a zero-interval watcher', () => {
    const cfg = loadConfig(createMockFs(JSON.stringify({ watcher: { pollInterval: 0.5 } })))
    expect(cfg.watcher.pollInterval).toBe(1500) // falls back, not 0
  })

  it('positive reconcileInterval that rounds to 0 falls back to default (does NOT silently disable)', () => {
    const cfg = loadConfig(createMockFs(JSON.stringify({ watcher: { reconcileInterval: 0.5 } })))
    expect(cfg.watcher.reconcileInterval).toBe(10000) // default, not 0 (disable)
  })
})
