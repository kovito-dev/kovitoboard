/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Integration tests for the startup status-restoration fix.
 *
 * These wire the REAL SessionManager to the REAL Watcher through a mock
 * fs-layer, closing the blind spot in admin-routes-status.test.ts (which
 * stubs getSessions and never exercises the real watcher → SessionManager
 * race). They assert the normative invariants:
 *
 *   INV-1: After startup, unless the user sends a genuinely-live event,
 *          every getSessions() status stays `idle`. The dropped-add /
 *          partial-hold / reconcile-recovery paths must not flip a
 *          pre-existing terminal `end_turn` into a non-idle status.
 *   INV-2: A genuinely-new live event after restoration completes still
 *          updates status normally.
 *
 * The closing end-to-end case feeds the same SessionManager into
 * createAdminRouter and asserts `GET /api/admin/status` returns `healthy`
 * for the path-E race (no false-positive degraded banner).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, mkdirSync } from 'fs'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { type Express } from 'express'

import { Watcher } from '../../src/server/watcher'
import { SessionManager } from '../../src/server/session-manager'
import { createAdminRouter } from '../../src/server/routes/admin-routes'
import { initLogger } from '../../src/server/logger'
import { _resetProjectRootCache } from '../../src/server/config'
import type { TmuxBridge } from '../../src/server/tmux-bridge'
import type {
  FileAccessLayer,
  WatchEvent,
  WatchHandle,
  WatchOptions,
  FileStat,
  FileLstat,
} from '../../src/server/fs-layer'
import type { ViewerConfig } from '../../src/server/types'

interface FileEntry {
  content: Buffer
  isFile?: boolean
  isSymbolicLink?: boolean
}

/** Controllable mock FS with an in-memory file table and watch hooks. */
class MockFs implements Partial<FileAccessLayer> {
  files = new Map<string, FileEntry>()
  dirs = new Set<string>()
  handlers = new Map<string, (e: WatchEvent) => void>()

  setFile(path: string, content: string, opts: Partial<FileEntry> = {}) {
    this.files.set(path, {
      content: Buffer.from(content, 'utf-8'),
      isFile: opts.isFile ?? true,
      isSymbolicLink: opts.isSymbolicLink ?? false,
    })
  }

  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  readdirSync(path: string): string[] {
    const prefix = path.endsWith('/') ? path : path + '/'
    const out: string[] = []
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.push(f.slice(prefix.length))
      }
    }
    return out
  }

  statSync(path: string): FileStat {
    const f = this.files.get(path)
    if (!f) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return { size: f.content.length, mtime: new Date(), mtimeMs: 0, isFile: f.isFile ?? true, isDirectory: false }
  }

  lstatSync(path: string): FileLstat {
    const f = this.files.get(path)
    if (!f) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return {
      size: f.content.length,
      mtime: new Date(),
      mtimeMs: 0,
      isFile: f.isFile ?? true,
      isDirectory: false,
      isSymbolicLink: f.isSymbolicLink ?? false,
    }
  }

  readBytesSync(path: string, offset: number, length: number): Buffer {
    const f = this.files.get(path)
    if (!f) throw new Error(`ENOENT: ${path}`)
    return f.content.subarray(offset, offset + length)
  }

  writeFileSync(): void {}
  unlinkSync(): void {}

  watch(path: string, handler: (e: WatchEvent) => void, _opts?: WatchOptions): WatchHandle {
    this.handlers.set(path, handler)
    return { close: () => this.handlers.delete(path) }
  }

  /** Drive a watch event into the handler registered for `watchedPath`. */
  emit(watchedPath: string, event: WatchEvent) {
    const h = this.handlers.get(watchedPath)
    if (h) h(event)
  }
}

const PROJECT_ROOT = '/home/test/proj'

function makeConfig(reconcileInterval = 100): ViewerConfig {
  return {
    claudeDir: '/home/test/.claude',
    watcher: { usePolling: true, pollInterval: 1500, reconcileInterval },
  } as ViewerConfig
}

/** A complete user line (drives status -> waiting when live). */
function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

/** A complete assistant line with stop_reason=end_turn (status -> ready when live). */
function endTurnLine(text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    }) + '\n'
  )
}

/** A static session: one user turn + a terminal end_turn assistant reply. */
function staticTranscript(): string {
  return userLine('please do the thing') + endTurnLine('done')
}

function statusOf(sm: SessionManager, sessionId: string): string | undefined {
  return sm.getSessions().find((s) => s.id === sessionId)?.status
}

describe('Watcher → SessionManager startup status restoration', () => {
  let claudeDirName: string
  let sessionsDir: string

  beforeAll(async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'kb-status-restore-test-'))
    mkdirSync(join(logRoot, '.kovitoboard', 'logs'), { recursive: true })
    await initLogger(logRoot, null)
  })

  beforeEach(() => {
    _resetProjectRootCache()
    process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
    claudeDirName = PROJECT_ROOT.replace(/\//g, '-')
    sessionsDir = join('/home/test/.claude', 'projects', claudeDirName)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.KOVITOBOARD_PROJECT_ROOT
    _resetProjectRootCache()
  })

  // --- Path E: pre-existing file whose first read lands after `ready` ---

  it('INV-1 / path E: first add AFTER ready keeps a terminal end_turn session idle', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    // ready fires first (initializing -> false), THEN the pre-existing
    // file's initial `add` is delivered (ordering not guaranteed; this is
    // the intermittent path-E ordering that branded a non-idle status).
    fs.emit(sessionsDir, { type: 'ready' })

    const file = join(sessionsDir, 'sess-e.jsonl')
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })

    expect(statusOf(sm, 'sess-e')).toBe('idle')
    // Session is still surfaced (stats aggregated despite historical status).
    expect(sm.getSessions().map((s) => s.id)).toContain('sess-e')

    w.stop()
  })

  it('INV-1 / path E control: first add BEFORE ready also keeps status idle', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    // The opposite ordering: the initial add is delivered first (covered by
    // the global `initializing` flag), ready second. Same idle outcome —
    // proving both orderings converge (intermittency removed).
    const file = join(sessionsDir, 'sess-e2.jsonl')
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })
    fs.emit(sessionsDir, { type: 'ready' })

    expect(statusOf(sm, 'sess-e2')).toBe('idle')

    w.stop()
  })

  // --- Path B: partial line on first add, completed by a later change ---

  it('INV-1 / path B: partial held on add, terminal completion via change stays idle', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    const file = join(sessionsDir, 'sess-b.jsonl')
    // First the user line is complete, but the terminal end_turn assistant
    // line is appended mid-write (no trailing newline yet).
    const complete = userLine('do it')
    const terminal = endTurnLine('all done')
    const partial = terminal.slice(0, terminal.length - 5) // drop tail incl. newline
    fs.setFile(file, complete + partial)
    fs.emit(sessionsDir, { type: 'add', path: file })

    // Only the user line was readable; status held idle (historical).
    expect(statusOf(sm, 'sess-b')).toBe('idle')

    // The terminal line completes on a later change. Confirmed runtime
    // behavior: this is the SECOND handleFile read of the same file, and
    // the file was still mid-partial (offset < EOF) on the first read, so
    // it is still in the restoring set — the completion line is treated as
    // historical and status MUST remain idle (INV-1 priority).
    fs.setFile(file, complete + terminal)
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-b')).toBe('idle')

    w.stop()
  })

  // --- Path C: live add dropped, recovered by the first reconcile tick ---

  it('INV-1 / path C: dropped add recovered by reconcile keeps status idle', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    // The live `add` is dropped (never emitted). The file exists on disk.
    const file = join(sessionsDir, 'sess-c.jsonl')
    fs.setFile(file, staticTranscript())

    // First reconcile tick recovers it as a first read → historical.
    vi.advanceTimersByTime(100)

    expect(statusOf(sm, 'sess-c')).toBe('idle')
    expect(sm.getSessions().map((s) => s.id)).toContain('sess-c')

    w.stop()
  })

  // --- INV-2: genuinely-live activity after restoration still updates status ---

  it('INV-2: a new file added live after ready updates status (restoration does not swallow live)', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    const file = join(sessionsDir, 'sess-live.jsonl')
    // First read drains a complete static transcript to EOF → historical,
    // restoring latch clears.
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })
    expect(statusOf(sm, 'sess-live')).toBe('idle')

    // A genuinely-live append (a fresh user turn) arrives as change. The
    // restoring latch is already cleared, so status must flip to waiting.
    fs.setFile(file, staticTranscript() + userLine('next question'))
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-live')).toBe('waiting')

    w.stop()
  })

  it('INV-2 / path E follow-up: live change after a path-E restore updates status', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    const file = join(sessionsDir, 'sess-ef.jsonl')
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })
    expect(statusOf(sm, 'sess-ef')).toBe('idle')

    // A live assistant reply that is still thinking (no end_turn) arrives.
    const thinking =
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      }) + '\n'
    fs.setFile(file, staticTranscript() + thinking)
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-ef')).toBe('thinking')

    w.stop()
  })

  // --- Restart regression: post-restart appends are live, not historical ---

  it('restart regression: start→stop→start, then an append to a known file is live', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    // First run: restore a static session, then stop.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    const file = join(sessionsDir, 'sess-restart.jsonl')
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })
    expect(statusOf(sm, 'sess-restart')).toBe('idle')
    w.stop()

    // Second run: filePositions is retained (not cleared on stop), so the
    // file is NOT a first read → not restoring. An append after restart is
    // genuine live activity and must update status.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    fs.setFile(file, staticTranscript() + userLine('after restart'))
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-restart')).toBe('waiting')

    w.stop()
  })

  it('INV-2 edge: a pre-existing EMPTY file does not stay restoring; its first append is live', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    // A pre-existing empty (size 0) .jsonl. Its first read marks it
    // restoring but then takes the no-new-bytes fast path; the latch must be
    // released there, otherwise the first genuine append below is wrongly
    // swallowed as historical.
    const file = join(sessionsDir, 'sess-empty.jsonl')
    fs.setFile(file, '')
    fs.emit(sessionsDir, { type: 'add', path: file })

    // First genuine live content arrives — must update status.
    fs.setFile(file, userLine('first real message'))
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-empty')).toBe('waiting')

    w.stop()
  })

  it('INV-1 edge: a partial held across a restart still completes as historical', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    // First run: the file has a complete user line plus a terminal end_turn
    // line that is still being appended (no trailing newline). The first
    // read commits only the user line and HOLDS the partial (offset < EOF),
    // so the file stays restoring. We then stop before the partial completes.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    const file = join(sessionsDir, 'sess-rp.jsonl')
    const complete = userLine('do it')
    const terminal = endTurnLine('all done')
    const partial = terminal.slice(0, terminal.length - 5)
    fs.setFile(file, complete + partial)
    fs.emit(sessionsDir, { type: 'add', path: file })
    expect(statusOf(sm, 'sess-rp')).toBe('idle')
    w.stop()

    // Second run: filePositions is retained, so isFirstRead=false. Without
    // carrying the restoring marker across stop(), the held pre-existing tail
    // would be read as a first post-restart change and mis-classified as
    // live. The terminal end_turn is pre-existing content, so status MUST
    // stay idle (INV-1).
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    fs.setFile(file, complete + terminal)
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-rp')).toBe('idle')

    // And once that restoration finally drains to EOF, a genuinely-live
    // append afterwards updates status (INV-2 — the latch released).
    fs.setFile(file, complete + terminal + userLine('next live turn'))
    fs.emit(sessionsDir, { type: 'change', path: file })
    expect(statusOf(sm, 'sess-rp')).toBe('waiting')

    w.stop()
  })

  it('INV-2 edge: a truncated/recreated file is not stuck restoring; later live append updates status', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    // First run: restore a static session (drains to EOF, latch released),
    // then stop with a retained offset.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    const file = join(sessionsDir, 'sess-trunc.jsonl')
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })
    w.stop()

    // The path is recreated SMALLER than the retained offset (truncate /
    // rotate / stale-path reuse) AFTER startup. The shrink must reset the
    // offset and any stale restoring marker. Because a shrink means the path
    // was already observed before, its new content is live activity (not
    // startup restoration), so status must update immediately — the
    // restoration rule must not leak into normal runtime.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    fs.setFile(file, userLine('brand new'))
    fs.emit(sessionsDir, { type: 'change', path: file })
    expect(statusOf(sm, 'sess-trunc')).toBe('waiting')

    // And a further genuinely-live append continues to update status.
    fs.setFile(file, userLine('brand new') + endTurnLine('reply'))
    fs.emit(sessionsDir, { type: 'change', path: file })
    expect(statusOf(sm, 'sess-trunc')).toBe('ready')

    w.stop()
  })

  it('INV-2 edge: mid-restoration stop then recreate-empty does not leave a stale restoring marker', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    // First run: the file's entire first read is a single newline-less
    // partial line, so no offset is committed (filePositions stays
    // undefined) but the path IS marked restoring. Stop before it completes.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    const file = join(sessionsDir, 'sess-mr.jsonl')
    fs.setFile(file, '{"type":"user","message":{"role":"user","content":"par') // no newline
    fs.emit(sessionsDir, { type: 'add', path: file })
    w.stop()

    // The path is recreated EMPTY before the next start (restoringFiles is
    // retained across stop()). The empty-file fast path must clear the stale
    // restoring marker so the first real append below is live.
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    fs.setFile(file, '')
    fs.emit(sessionsDir, { type: 'add', path: file })

    fs.setFile(file, userLine('genuinely live'))
    fs.emit(sessionsDir, { type: 'change', path: file })

    expect(statusOf(sm, 'sess-mr')).toBe('waiting')

    w.stop()
  })

  // --- End-to-end: path-E race yields healthy /api/admin/status ---

  it('end-to-end: path-E restore yields healthy GET /api/admin/status (no false degraded)', async () => {
    vi.useRealTimers() // express/http needs real timers
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new SessionManager()
    const w = new Watcher(makeConfig(100), sm, fs as never)

    w.start()
    fs.emit(sessionsDir, { type: 'ready' })
    const file = join(sessionsDir, 'sess-http.jsonl')
    fs.setFile(file, staticTranscript())
    fs.emit(sessionsDir, { type: 'add', path: file })

    // Sanity: the SSOT status is idle.
    expect(statusOf(sm, 'sess-http')).toBe('idle')

    // tmux is absent (lazy-spawn idle state). With status correctly idle,
    // hasActiveSession=false → healthy (admin-routes is unchanged).
    const tmuxBridge = {
      get sessionName() {
        return 'kovitoboard-test'
      },
      hasSession() {
        return false
      },
      listWindows() {
        return []
      },
    } as unknown as TmuxBridge

    const app: Express = express()
    app.use('/api/admin', createAdminRouter(tmuxBridge, Date.now(), sm))

    const server: Server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    try {
      const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, method: 'GET', path: '/api/admin/status' },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))))
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(body.status).toBe('healthy')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      w.stop()
    }
  })
})
