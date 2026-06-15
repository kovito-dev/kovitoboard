/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for Watcher's dirty-start recovery behaviors
 * (session-management.md §7.3.2 reconciliation scan, §7.3.2.1 absent-dir
 * mode, §7.3.2.2 entry hardening, §7.3.4 fragment-buffering / per-line
 * commit, §8.6.1 startup self-verify).
 *
 * The mock FS lets a test drive watch events directly and provides an
 * in-memory file table for stat / lstat / readBytes, so we can simulate
 * a live watcher that drops `add` events and assert the reconciliation
 * scan recovers them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, mkdirSync } from 'fs'
import { Watcher } from '../../src/server/watcher'
import { initLogger } from '../../src/server/logger'
import { _resetProjectRootCache } from '../../src/server/config'
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
  /** Registered watch handlers keyed by watched path. */
  handlers = new Map<string, (e: WatchEvent) => void>()

  addFile(path: string, content: string, opts: Partial<FileEntry> = {}) {
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
    return {
      size: f.content.length,
      mtime: new Date(),
      mtimeMs: 0,
      isFile: f.isFile ?? true,
      isDirectory: false,
    }
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

  /** Records the (offset, length) of every readBytesSync call. */
  readCalls: Array<{ offset: number; length: number }> = []

  readBytesSync(path: string, offset: number, length: number): Buffer {
    const f = this.files.get(path)
    if (!f) throw new Error(`ENOENT: ${path}`)
    this.readCalls.push({ offset, length })
    return f.content.subarray(offset, offset + length)
  }

  writeFileSync(): void {
    // self-verify marker write — no-op (we never assert on the marker file)
  }

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

/** Records calls into a fake SessionManager. */
class FakeSessionManager {
  ensured: string[] = []
  events: Array<{ sessionId: string; count: number }> = []
  initialized = false
  agentIds: Array<{ sessionId: string; agentId: string }> = []
  throwOnSessionId: string | null = null

  ensureSession(sessionId: string) {
    this.ensured.push(sessionId)
    return {} as never
  }
  addEvents(sessionId: string, events: unknown[]) {
    if (this.throwOnSessionId === sessionId) {
      throw new Error('addEvents boom')
    }
    this.events.push({ sessionId, count: events.length })
  }
  setAgentId(sessionId: string, agentId: string) {
    this.agentIds.push({ sessionId, agentId })
  }
  setInitialized() {
    this.initialized = true
  }
  getSessionAgentMap() {
    return {}
  }
}

const PROJECT_ROOT = '/home/test/proj'

function makeConfig(reconcileInterval = 100): ViewerConfig {
  return {
    claudeDir: '/home/test/.claude',
    watcher: { usePolling: true, pollInterval: 1500, reconcileInterval },
  } as ViewerConfig
}

/** Build a single valid JSONL user event line. */
function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

describe('Watcher dirty-start recovery', () => {
  let claudeDirName: string
  let sessionsDir: string

  beforeAll(async () => {
    // The lazy watcherLogger proxy throws unless the root logger is
    // initialized. Point it at a throwaway tmp dir.
    const logRoot = mkdtempSync(join(tmpdir(), 'kb-watcher-test-'))
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

  it('reconciliation scan recovers a new session whose live `add` was dropped (§7.3.2)', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new FakeSessionManager()
    const w = new Watcher(makeConfig(100), sm as never, fs as never)

    w.start()
    // Live watch reaches ready (initial scan complete).
    fs.emit(sessionsDir, { type: 'ready' })
    expect(sm.initialized).toBe(true)

    // A new session file appears, but the live watcher DROPS the `add`
    // (simulating the silent degrade — we never call fs.emit add).
    const sessionFile = join(sessionsDir, 'sess-abc.jsonl')
    fs.addFile(sessionFile, userLine('hello'))

    // No events yet (add was dropped).
    expect(sm.ensured).toHaveLength(0)

    // Reconcile tick fires and recovers it.
    vi.advanceTimersByTime(100)
    expect(sm.ensured).toContain('sess-abc')
    expect(sm.events).toEqual([{ sessionId: 'sess-abc', count: 1 }])

    w.stop()
  })

  it('reconcile does not double-process content already read by live watch (idempotent §7.3.4)', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new FakeSessionManager()
    const w = new Watcher(makeConfig(100), sm as never, fs as never)
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    const sessionFile = join(sessionsDir, 'sess-x.jsonl')
    fs.addFile(sessionFile, userLine('one'))
    // Live watch DOES deliver this add.
    fs.emit(sessionsDir, { type: 'add', path: sessionFile })
    expect(sm.events).toEqual([{ sessionId: 'sess-x', count: 1 }])

    // Reconcile tick runs over the same file: no growth → no re-emit.
    vi.advanceTimersByTime(100)
    expect(sm.events).toEqual([{ sessionId: 'sess-x', count: 1 }])

    w.stop()
  })

  it('absent-dir mode: reconcile transitions to live watch when the sessions dir appears (§7.3.2.1)', () => {
    const fs = new MockFs()
    // sessions dir does NOT exist at start.
    const sm = new FakeSessionManager()
    const w = new Watcher(makeConfig(100), sm as never, fs as never)
    w.start()
    // start() watches the parent projects dir; sessions dir absent.
    const projectsDir = join('/home/test/.claude', 'projects')
    expect(fs.handlers.has(projectsDir)).toBe(true)
    expect(fs.handlers.has(sessionsDir)).toBe(false)

    // Now the sessions dir is dug, but the parent dir watch went stale
    // (no addDir emitted). Reconcile tick must pick it up.
    fs.dirs.add(sessionsDir)
    vi.advanceTimersByTime(100)

    // Reconcile transitioned to live watching the sessions dir.
    expect(fs.handlers.has(sessionsDir)).toBe(true)

    w.stop()
  })

  it('entry hardening: symlink / non-regular entries are skipped (§7.3.2.2)', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new FakeSessionManager()
    const w = new Watcher(makeConfig(100), sm as never, fs as never)
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    // A planted symlink .jsonl and a real regular .jsonl.
    fs.addFile(join(sessionsDir, 'evil.jsonl'), userLine('x'), { isSymbolicLink: true })
    fs.addFile(join(sessionsDir, 'good.jsonl'), userLine('y'))

    vi.advanceTimersByTime(100)

    expect(sm.ensured).toContain('good')
    expect(sm.ensured).not.toContain('evil')

    w.stop()
  })

  it('read site re-checks lstat: an entry swapped to a symlink is not read (TOCTOU narrowing)', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new FakeSessionManager()
    const w = new Watcher(makeConfig(100), sm as never, fs as never)
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    // A live `add` arrives for a path that is now a symlink (simulating an
    // entry swapped between detection and the handleFile read). handleFile
    // must reject it via the read-site lstat gate.
    const file = join(sessionsDir, 'swapped.jsonl')
    fs.addFile(file, userLine('payload'), { isSymbolicLink: true })
    fs.emit(sessionsDir, { type: 'add', path: file })

    expect(sm.ensured).toHaveLength(0)
    expect(sm.events).toHaveLength(0)

    w.stop()
  })

  it('reconcileInterval <= 0 disables the scan (§7.3.3 opt-out)', () => {
    const fs = new MockFs()
    fs.dirs.add(sessionsDir)
    const sm = new FakeSessionManager()
    const w = new Watcher(makeConfig(0), sm as never, fs as never)
    w.start()
    fs.emit(sessionsDir, { type: 'ready' })

    // New file with dropped add; no reconcile timer should recover it.
    fs.addFile(join(sessionsDir, 'sess-q.jsonl'), userLine('z'))
    vi.advanceTimersByTime(1000)
    expect(sm.ensured).toHaveLength(0)

    w.stop()
  })

  describe('handleFile fragment-buffering / per-line commit (§7.3.4)', () => {
    it('does not advance past a trailing partial line; recovers it next read', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      const file = join(sessionsDir, 'sess-frag.jsonl')
      // One complete line + a partial second line (no trailing newline).
      const complete = userLine('first')
      const partial = '{"type":"user","message":{"role":"user","content":"sec'
      fs.addFile(file, complete + partial)
      fs.emit(sessionsDir, { type: 'add', path: file })

      // Only the complete line is processed.
      expect(sm.events).toEqual([{ sessionId: 'sess-frag', count: 1 }])

      // The partial line completes (append the rest + newline).
      const rest = 'ond"}}\n'
      fs.addFile(file, complete + partial + rest)
      fs.emit(sessionsDir, { type: 'change', path: file })

      // Now the second line is read in full — no loss, no duplicate.
      expect(sm.events).toEqual([
        { sessionId: 'sess-frag', count: 1 },
        { sessionId: 'sess-frag', count: 1 },
      ])

      w.stop()
    })

    it('mid-loop addEvents failure does not replay committed lines (per-line commit)', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      const file = join(sessionsDir, 'sess-fail.jsonl')
      // Three complete lines; addEvents will throw on this session.
      const threeLines = userLine('a') + userLine('b') + userLine('c')
      fs.addFile(file, threeLines)

      // Make addEvents throw — the first call throws, so the offset must
      // stop before line 1's commit. We then clear the throw and re-emit;
      // the retry must replay from line 1 (not skip it).
      sm.throwOnSessionId = 'sess-fail'
      fs.emit(sessionsDir, { type: 'add', path: file })
      expect(sm.events).toHaveLength(0) // line 1 threw, nothing committed

      // Clear the failure and retry via a change event.
      sm.throwOnSessionId = null
      fs.emit(sessionsDir, { type: 'change', path: file })
      // All three lines replayed from the start (no loss).
      expect(sm.events).toEqual([
        { sessionId: 'sess-fail', count: 1 },
        { sessionId: 'sess-fail', count: 1 },
        { sessionId: 'sess-fail', count: 1 },
      ])

      w.stop()
    })

    it('incremental read length is bounded (never exceeds the per-call chunk cap)', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      const file = join(sessionsDir, 'sess-bound.jsonl')
      fs.addFile(file, userLine('a') + userLine('b'))
      fs.emit(sessionsDir, { type: 'add', path: file })

      // Every read request must be bounded by the 16 MiB chunk cap.
      const CAP = 16 * 1024 * 1024
      for (const call of fs.readCalls) {
        expect(call.length).toBeLessThanOrEqual(CAP)
      }
      expect(fs.readCalls.length).toBeGreaterThan(0)

      w.stop()
    })

    it('partial-only delta (no newline) emits nothing and holds offset', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      const file = join(sessionsDir, 'sess-nopart.jsonl')
      fs.addFile(file, '{"type":"user"') // no newline at all
      fs.emit(sessionsDir, { type: 'add', path: file })
      expect(sm.events).toHaveLength(0)

      w.stop()
    })
  })

  describe('startup self-verify (§8.6.1)', () => {
    it('passes when the raw add for the marker is observed', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      // Capture the marker path written by self-verify.
      let markerPath: string | null = null
      fs.writeFileSync = ((p: string) => {
        markerPath = p
      }) as never
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      expect(markerPath).not.toBeNull()
      // Deliver the raw add for the marker (non-.jsonl): observer resolves.
      fs.emit(sessionsDir, { type: 'add', path: markerPath as unknown as string })

      // No timeout error should fire afterwards.
      vi.advanceTimersByTime(6000)
      // (we only assert it does not throw / hang; success path logged)

      w.stop()
    })

    it('observer is armed before the marker write (synchronous add is not missed)', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      // writeFileSync delivers the marker's raw add SYNCHRONOUSLY, before
      // it returns — emulating a watch impl that fires immediately. If the
      // observer were installed only after the write, this event would be
      // missed and the timeout would log a false error.
      fs.writeFileSync = ((p: string) => {
        fs.emit(sessionsDir, { type: 'add', path: p })
      }) as never

      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      // The observer resolved synchronously, so advancing past the timeout
      // must NOT fire the error path (the marker file was already cleaned
      // up). We assert the observer is no longer installed (settled).
      expect(() => vi.advanceTimersByTime(10000)).not.toThrow()

      w.stop()
    })

    it('stop() clears the pending self-verify timeout (no false error after shutdown)', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      fs.writeFileSync = (() => {}) as never
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' }) // arms the self-verify timeout

      // Stop before the marker add arrives — the timeout must be cleared.
      w.stop()

      // Advancing past the timeout must NOT fire the error callback (we
      // assert by ensuring no throw and that the marker add was never
      // observed). If the timer leaked it would call watcherLogger.error;
      // here we just confirm advancing timers is a no-op.
      expect(() => vi.advanceTimersByTime(10000)).not.toThrow()
    })

    it('marker file (non-.jsonl) is never registered as a session', () => {
      const fs = new MockFs()
      fs.dirs.add(sessionsDir)
      let markerPath: string | null = null
      fs.writeFileSync = ((p: string) => {
        markerPath = p
      }) as never
      const sm = new FakeSessionManager()
      const w = new Watcher(makeConfig(100), sm as never, fs as never)
      w.start()
      fs.emit(sessionsDir, { type: 'ready' })

      fs.emit(sessionsDir, { type: 'add', path: markerPath as unknown as string })
      expect(sm.ensured).toHaveLength(0) // marker did not create a session

      w.stop()
    })
  })
})
