/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { parseLine } from './parser'
import { loadSessionAgentRecords, buildSessionAgentMap } from './agent-reader'
import { resolveProjectRoot } from './config'
import type { FileAccessLayer, WatchEvent, WatchHandle } from './fs-layer'
import type { SessionManager } from './session-manager'
import type { ViewerConfig } from './types'
import { watcherLogger } from './logger'

/**
 * Convert a project root path to a Claude project directory name.
 * Example: "/home/user/my-project" → "-home-user-my-project"
 */
function projectPathToClaudeDirName(projectRoot: string): string {
  return projectRoot.replace(/\//g, '-')
}

/** Default reconciliation scan period when config omits it (session-management.md §7.3.3). */
const DEFAULT_RECONCILE_INTERVAL = 10000

/** Timeout (ms) for the startup self-verify marker round-trip (§8.6.1). */
const SELF_VERIFY_TIMEOUT_MS = 5000

/**
 * Upper bound (bytes) on a single incremental read in handleFile
 * (session-management.md §7.3.2.2 / §8.10 R3). The live watcher and the
 * reconciliation scan both call handleFile; if a registered session
 * missed `change` events and then grows by a very large delta before the
 * next read, reading the whole delta into one Buffer could exhaust
 * memory. We read at most this many bytes per call; because filePositions
 * only advances to the last committed line, the remaining bytes are
 * picked up on the next live `change` / reconcile tick. Normal Claude
 * Code JSONL deltas are far smaller than this cap.
 */
const HANDLE_FILE_READ_CHUNK_BYTES = 16 * 1024 * 1024 // 16 MiB

export class Watcher {
  private watchHandle: WatchHandle | null = null
  // Read byte position per file
  private filePositions = new Map<string, number>()
  /**
   * Files whose handleFile currently fails (stat / read error). Tracked so
   * the reconcile scan logs the error once per file at `error` level and
   * then suppresses it to `debug` on subsequent ticks, avoiding unbounded
   * log growth from a single persistently-broken `.jsonl`. Cleared for a
   * file once it processes successfully (or on stop()).
   */
  private failedFiles = new Set<string>()
  /**
   * Files currently in the startup-restoration phase. A file
   * is added on its first-ever read (offset previously undefined) and stays
   * in the set until its first read that drains it fully to EOF on a
   * newline boundary. While a file is in this set, its parsed events are
   * passed to `addEvents` with `{ historical: true }`, so a pre-existing
   * terminal `end_turn` line does not brand a non-idle `status` after the
   * watcher's `ready` (the false-degraded root cause).
   *
   * Why per-file drain-to-EOF rather than "first read only": Claude Code
   * appends JSONL mid-line, so the first read can stop at a partial line
   * (path B). The partial completes on a later `change`, which is a SECOND
   * read of the same file — a naive "first read only" check would
   * mis-classify that completion line as live and flip status. Keeping the
   * file restoring until the first full drain to EOF treats the completion
   * line as restored (idle held), then clears so the next genuinely-live
   * append updates status normally (INV-2).
   */
  private restoringFiles = new Set<string>()
  private claudeDir: string
  private fullConfig: ViewerConfig
  private config: ViewerConfig['watcher']
  private sessionManager: SessionManager
  private fs: FileAccessLayer

  // Reconciliation scan state (§7.3.2)
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private reconcileInterval: number
  /** Set once startWatching() has attached to the real sessions dir. */
  private watchingStarted = false
  /** Resolved at start(); used by the reconcile scan for readdir/existsSync. */
  private projectSessionsDir: string | null = null
  private usePolling = true
  private pollInterval = 1500

  // Self-verify state (§8.6.1)
  private selfVerifyDone = false
  /** Active self-verify marker observer; resolves on the marker's raw add. */
  private selfVerifyObserver: ((path: string) => void) | null = null
  /** Pending self-verify timeout, cleared on stop() to avoid a post-shutdown false error. */
  private selfVerifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: ViewerConfig, sessionManager: SessionManager, fs: FileAccessLayer) {
    this.claudeDir = config.claudeDir
    this.fullConfig = config
    this.config = config.watcher
    this.sessionManager = sessionManager
    this.fs = fs
    const ri = config.watcher.reconcileInterval
    this.reconcileInterval = typeof ri === 'number' ? ri : DEFAULT_RECONCILE_INTERVAL
  }

  start(): void {
    // Watch only the Claude session directory corresponding to the current project
    const projectRoot = resolveProjectRoot(this.fs)
    const claudeDirName = projectPathToClaudeDirName(projectRoot)
    const projectSessionsDir = join(this.claudeDir, 'projects', claudeDirName)

    const usePolling = this.config.usePolling
    const pollInterval = this.config.pollInterval

    this.projectSessionsDir = projectSessionsDir
    this.usePolling = usePolling
    this.pollInterval = pollInterval

    watcherLogger.info({ projectRoot }, 'Project root')
    watcherLogger.info({ path: projectSessionsDir }, 'Watching')
    watcherLogger.info(
      { mode: usePolling ? 'polling' : 'inotify', pollInterval: usePolling ? pollInterval : null },
      'Watch mode',
    )

    // Start the reconciliation scan independently of the live watcher
    // (§7.3.2). It is a universal safety net: in absent-dir startup it
    // polls for the sessions dir to appear; once present it recovers any
    // add/change events the live watcher dropped (silent degrade §7.3.1).
    this.startReconciliationScan()

    // If the directory does not exist (no sessions yet), wait for it to be created
    if (!this.fs.existsSync(projectSessionsDir)) {
      watcherLogger.info('Session directory not yet created. Watching parent directory and waiting.')
      const projectsDir = join(this.claudeDir, 'projects')
      // Watch the parent directory and switch when the target directory
      // appears. Guard the attach: a synchronous fs.watch() throw (e.g.
      // EMFILE / EPERM) must NOT escape start() and crash the server
      // (start() is called directly from index.ts). On failure we warn and
      // fall through to the reconcile scan, which was already started above
      // and polls existsSync for the sessions dir to appear (absent-dir
      // mode §7.3.2.1), then transitions to live watching itself.
      try {
        this.watchHandle = this.fs.watch(
          projectsDir,
          (event: WatchEvent) => {
            if (event.type === 'addDir') {
              if (basename(event.path) === claudeDirName) {
                watcherLogger.info({ path: event.path }, 'Session directory detected')
                this.transitionToWatching(projectSessionsDir, usePolling, pollInterval)
              }
            } else if (event.type === 'ready') {
              // Re-check if the directory exists at ready time
              if (this.fs.existsSync(projectSessionsDir)) {
                this.transitionToWatching(projectSessionsDir, usePolling, pollInterval)
              } else {
                watcherLogger.info('Initial scan complete (no sessions)')
                this.sessionManager.setInitialized()
              }
            }
          },
          {
            usePolling,
            pollInterval,
            ignoreInitial: false,
            depth: 0,
          }
        )
      } catch (err) {
        watcherLogger.warn(
          { err, projectsDir },
          'Failed to attach parent-directory watch; reconcile scan will poll for the sessions dir',
        )
      }
      return
    }

    // DEC-014: Inform the user when past session logs exist for this project path.
    // Claude Code stores logs by absolute path, so re-using a path resurfaces
    // prior history — surface that in the startup log to reduce surprise.
    try {
      const existing = this.fs.readdirSync(projectSessionsDir).filter((f) => f.endsWith('.jsonl'))
      if (existing.length > 0) {
        watcherLogger.info(
          { count: existing.length },
          'Found existing session log file(s) for this project path',
        )
      }
    } catch {
      // Non-fatal: skip the informational message
    }

    this.startWatching(projectSessionsDir, usePolling, pollInterval)
  }

  /**
   * Idempotently switch from the absent-dir parent watch to watching the
   * real sessions dir. Guards against the live `addDir` event and the
   * reconcile scan's existsSync probe both firing the transition
   * (§7.3.2.1).
   */
  private transitionToWatching(
    projectSessionsDir: string,
    usePolling: boolean,
    pollInterval: number,
  ): void {
    if (this.watchingStarted) return
    this.watchHandle?.close()
    this.watchHandle = null
    this.startWatching(projectSessionsDir, usePolling, pollInterval)
  }

  private startWatching(watchDir: string, usePolling: boolean, pollInterval: number): void {
    if (this.watchingStarted) return
    // Set the latch only AFTER fs.watch() returns successfully. If it
    // throws synchronously (the codebase treats this as possible, cf.
    // watchSettingsFile), leaving watchingStarted=true would make the
    // reconcile loop stop retrying the transition, permanently disabling
    // live add/change events and self-verify until restart. On failure we
    // warn and leave the latch false so the next reconcile tick retries
    // the transition (the scan still recovers events meanwhile).
    let handle: WatchHandle
    try {
      handle = this.fs.watch(
      watchDir,
      (event: WatchEvent) => {
        if (event.type === 'add' || event.type === 'change') {
          // Feed the raw add stream to the self-verify observer BEFORE the
          // .jsonl filter so the (non-.jsonl) marker file is observable
          // (§8.6.1). The marker has no .jsonl extension and so never
          // reaches handleFile / session registration.
          if (event.type === 'add' && this.selfVerifyObserver) {
            this.selfVerifyObserver(event.path)
          }
          if (event.path.endsWith('.jsonl')) this.handleFile(event.path)
        } else if (event.type === 'ready') {
          watcherLogger.info('Initial scan complete')
          this.applyFallbackAgentMapping()
          this.sessionManager.setInitialized()
          // Run the startup self-verify after the live watch is attached
          // and the initial scan is done (§8.6.1). Non-blocking.
          this.runSelfVerify(watchDir)
        } else if (event.type === 'error') {
          watcherLogger.error({ err: event.error }, 'Watch error')
          // Fall back to polling on inotify error
          if (!usePolling) {
            watcherLogger.warn('Falling back to polling due to inotify error')
            this.watchHandle?.close()
            this.watchHandle = this.fs.watch(
              watchDir,
              (ev: WatchEvent) => {
                if (ev.type === 'add' || ev.type === 'change') {
                  if (ev.type === 'add' && this.selfVerifyObserver) {
                    this.selfVerifyObserver(ev.path)
                  }
                  if (ev.path.endsWith('.jsonl')) this.handleFile(ev.path)
                } else if (ev.type === 'ready') {
                  // The fallback (polling) watcher is now the live watch.
                  // Drive the same ready handling so initialization /
                  // fallback agent mapping happen even when the inotify
                  // watcher errored before its own `ready`, and run
                  // self-verify on this watcher — exactly the degraded
                  // path this fix aims to make fail-loud. setInitialized
                  // and the self-verify one-shot latch are both idempotent
                  // if the primary watcher already reached ready.
                  watcherLogger.info('Initial scan complete (fallback polling watcher)')
                  this.applyFallbackAgentMapping()
                  this.sessionManager.setInitialized()
                  this.runSelfVerify(watchDir)
                } else if (ev.type === 'error') {
                  watcherLogger.error({ err: ev.error }, 'Fallback watch error')
                }
              },
              {
                usePolling: true,
                pollInterval: 500,
                ignoreInitial: false,
              }
            )
          }
        }
      },
      {
        usePolling,
        pollInterval,
        ignoreInitial: false,
      }
      )
    } catch (err) {
      watcherLogger.warn(
        { err, watchDir },
        'Failed to attach live watch; reconcile scan will retry the transition',
      )
      return
    }
    this.watchHandle = handle
    this.watchingStarted = true
  }

  stop(): void {
    this.watchHandle?.close()
    this.watchHandle = null
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    // Clear any pending self-verify timeout so it cannot log a false
    // "add subscription may be dead" error after shutdown.
    if (this.selfVerifyTimer) {
      clearTimeout(this.selfVerifyTimer)
      this.selfVerifyTimer = null
    }
    this.selfVerifyObserver = null

    // Reset the lifecycle latches so a later start() on the same instance
    // attaches a fresh watch and re-runs self-verify, instead of returning
    // inert because watchingStarted / selfVerifyDone are still set from the
    // previous run. filePositions is intentionally NOT cleared: a restart
    // should resume from the last committed offsets rather than replay
    // every existing session from the start.
    this.watchingStarted = false
    this.selfVerifyDone = false
    this.failedFiles.clear()
    // restoringFiles is intentionally NOT cleared, mirroring filePositions
    // (see above). A file is removed from this set the moment its first read
    // drains it to EOF, so by the time stop() runs the set holds ONLY files
    // whose restoration is still incomplete (a partial line was held, offset
    // < EOF). Those files must stay restoring across a restart: their
    // retained offset makes the next start() see isFirstRead=false, so
    // without this carry-over the held pre-existing tail would be read as a
    // first post-restart "change" and mis-classified as live, branding a
    // non-idle status from pre-existing content (INV-1). Fully-restored
    // files are already absent here, so post-restart appends to them are
    // correctly treated as live (INV-2).
  }

  // --- Reconciliation scan (§7.3.2, safety net) ---

  /**
   * Start the periodic reconciliation scan (§7.3.2). Independent of the
   * live watcher's survival, it recovers dropped add/change events by
   * periodically reading the sessions dir. When the dir does not yet
   * exist it acts as an existsSync poll (absent-dir mode §7.3.2.1) and
   * transitions to live watching when the dir appears — recovering the
   * first session even if the parent dir watch went stale on dirty start.
   *
   * `reconcileInterval <= 0` disables the scan (operator opt-out §7.3.3).
   */
  private startReconciliationScan(): void {
    if (this.reconcileInterval <= 0) {
      watcherLogger.info('Reconciliation scan disabled (reconcileInterval <= 0)')
      return
    }
    if (this.reconcileTimer) return
    this.reconcileTimer = setInterval(() => {
      try {
        this.reconcileTick()
      } catch (err) {
        // A scan failure must never crash the process; warn and continue
        // on the next tick (§8.7 observability).
        watcherLogger.warn({ err }, 'Reconciliation scan tick failed')
      }
    }, this.reconcileInterval)
    // Do not keep the event loop alive solely for the scan timer.
    this.reconcileTimer.unref?.()
  }

  /** One reconciliation scan tick (§7.3.2 algorithm). */
  private reconcileTick(): void {
    const dir = this.projectSessionsDir
    if (!dir) return

    // Step 0: absent-dir mode (§7.3.2.1). If the sessions dir does not
    // yet exist, poll for it; when it appears, transition to live
    // watching (which performs the initial scan + recovers existing
    // .jsonl). Then return — present-dir scan runs on the next tick.
    if (!this.fs.existsSync(dir)) {
      watcherLogger.debug('Reconcile: sessions dir not yet present')
      return
    }
    if (!this.watchingStarted) {
      watcherLogger.info(
        { path: dir },
        'Reconcile: sessions dir appeared; transitioning to live watching',
      )
      this.transitionToWatching(dir, this.usePolling, this.pollInterval)
      return
    }

    // Step 1: list current .jsonl files. A dir-level failure (readdir
    // throws / ENOENT) skips this tick with one warn (§8.7); next tick
    // continues.
    let entries: string[]
    try {
      entries = this.fs.readdirSync(dir)
    } catch (err) {
      watcherLogger.warn({ err, path: dir }, 'Reconcile: readdir failed; skipping this tick')
      return
    }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const filePath = join(dir, name)
      try {
        // §7.3.2.2 entry hardening: kind-gate via lstatSync (does NOT
        // follow symlinks). Only regular files are read. symlink / FIFO /
        // device / directory are skipped. The kind gate MUST use lstat,
        // not stat, to avoid re-introducing symlink-follow / special-file
        // exposure.
        const lst = this.fs.lstatSync(filePath)
        if (!lst.isFile || lst.isSymbolicLink) continue

        const currentSize = lst.size
        const recorded = this.filePositions.get(filePath)
        // Recover only: unregistered (live watcher dropped the `add`) or
        // grown past the recorded offset (dropped `change`). handleFile is
        // idempotent (§7.3.4 commit boundary), so double-processing with
        // the live watch is safe. handleFile bounds its own read to a
        // fixed chunk and advances filePositions per committed line
        // (§7.3.2.2 / §8.10 R3), so even an anomalously large unregistered
        // file makes forward progress across ticks instead of stalling —
        // no per-tick deferral / log spam here.
        if (recorded === undefined || currentSize > recorded) {
          this.handleFile(filePath)
        }
      } catch (err) {
        // Per-entry failure (e.g. file vanished between readdir and lstat,
        // or an individual read error) skips only this entry and continues
        // the tick (§7.3.2 step 2 / §8.7). It must not starve other
        // sessions' detection.
        watcherLogger.warn({ err, filePath }, 'Reconcile: per-entry failure; skipping entry')
      }
    }

    // External-client sidecar-correlation retry (external-client-api.md
    // §7.3.2.1 (S-7)). The per-file `ensureSession` stamp only fires on
    // file growth; this gives the retry a growth-INDEPENDENT driver so a
    // sidecar that catches up after the first `new_session` batch (with
    // no further JSONL writes) is still picked up within the launch TTL.
    // No-op while no ext launch is in flight.
    this.sessionManager.retryExtCorrelationForUnbound()
  }

  /**
   * Apply fallback agent mapping from `.kovitoboard/session-agents.jsonl`
   * to sessions that had no agent-setting event.
   */
  private applyFallbackAgentMapping(): void {
    const records = loadSessionAgentRecords(this.fs, this.fullConfig)
    if (records.length === 0) return

    const fallbackMap = buildSessionAgentMap(records)
    const currentMap = this.sessionManager.getSessionAgentMap()
    let applied = 0

    for (const [sessionId, agentType] of fallbackMap) {
      if (!currentMap[sessionId]) {
        this.sessionManager.setAgentId(sessionId, agentType)
        applied++
      }
    }

    if (applied > 0) {
      watcherLogger.info({ count: applied }, 'Fallback agent mapping applied')
    }
  }

  private handleFile(filePath: string): void {
    try {
      // Use lstat (not stat) at the read site too, mirroring the
      // reconcile kind-gate (§7.3.2.2). This narrows the readdir→read
      // TOCTOU window: if the entry was swapped for a symlink / FIFO /
      // device / directory between the reconcile lstat and this read, the
      // read path rejects it here instead of following the link or
      // blocking on a special file. (The same-UID entry-swap race itself
      // is an accepted same-user condition per the spec's per-entry
      // skip-and-continue contract; this re-check shrinks the window.)
      const stat = this.fs.lstatSync(filePath)
      if (!stat.isFile || stat.isSymbolicLink) return
      const currentSize = stat.size

      // Truncate / replace / recreate detection. If the file is now SMALLER
      // than our recorded offset, the path no longer refers to the bytes we
      // committed against (Claude Code may rotate or a stale path may be
      // reused). Drop the stale offset AND any stale restoration marker so
      // the file is re-evaluated from scratch below. Without this, a stale
      // `restoringFiles` entry kept across stop() (see stop()) combined with
      // the `currentSize <= previousPosition` early return could suppress
      // status updates for the recreated file indefinitely.
      const recordedOffset = this.filePositions.get(filePath)
      const isRecreate = recordedOffset !== undefined && currentSize < recordedOffset
      if (isRecreate) {
        this.filePositions.delete(filePath)
        this.restoringFiles.delete(filePath)
      }

      // First-ever read of this file? Computed from the raw offset map
      // (undefined === never read) BEFORE the `|| 0` fallback below, since
      // a genuine offset of 0 is indistinguishable from "never read" after
      // the fallback. On first read we mark the file as restoring so its
      // pre-existing content does not update `status`.
      const isFirstRead = this.filePositions.get(filePath) === undefined
      // Mark the file as restoring only when it already has pre-existing
      // bytes at its first observation. "Restoring" means replaying content
      // that existed on disk before we started reading this file; an EMPTY
      // file (size 0) has nothing to restore, so its first genuine append is
      // live activity and must update status (INV-2).
      //
      // A RECREATE (shrink) is excluded: restoration is a startup-only
      // concept for bytes that pre-date our first observation of a path. By
      // definition a shrink means we already observed this path before, so
      // its new (smaller) content was written after we started reading and
      // is live activity — re-entering restoration here would extend the
      // startup rule into normal runtime and hide genuine live status (the
      // pre-`ready` window is already covered by SessionManager.initializing,
      // so leaving a recreate live is harmless during startup and correct
      // after it).
      if (isFirstRead && currentSize > 0 && !isRecreate) this.restoringFiles.add(filePath)
      const historical = this.restoringFiles.has(filePath)
      const previousPosition = this.filePositions.get(filePath) || 0

      if (isFirstRead && currentSize === 0) {
        // First observation of an empty pre-existing file: record offset 0 so
        // it is no longer treated as a first read. Without this, the empty
        // file never gets a filePositions entry, so the read that finally
        // brings its first content is still isFirstRead=true and would be
        // marked restoring — swallowing that genuinely-live first append's
        // status transition (INV-2). Recording it here makes the next append
        // read live.
        //
        // Also clear any stale restoring marker for this path. A marker can
        // survive across a restart (restoringFiles is retained in stop()) for
        // a file that stopped mid-restoration without ever committing an
        // offset (its whole first read was a single newline-less partial). If
        // that path is then recreated EMPTY before the next start(), the
        // empty file has nothing to restore, so the marker must not persist
        // and swallow the first real append's status (INV-2).
        this.restoringFiles.delete(filePath)
        this.filePositions.set(filePath, 0)
        return
      }

      // Idempotent: no new bytes since the last commit (§7.3.4). Safe to
      // re-enter from both live watch and the reconcile scan.
      if (currentSize <= previousPosition) return

      // Session ID: filename without extension
      const sessionId = basename(filePath, '.jsonl')
      // Project path: parent directory name
      const projectPath = basename(dirname(filePath))

      // Skip files in the subagents directory (to be supported later)
      if (filePath.includes('/subagents/')) return

      this.sessionManager.ensureSession(sessionId, projectPath, filePath)

      // Incremental read (via fs-layer), bounded per call so a large
      // unread delta (e.g. a registered session that missed `change`
      // events and grew a lot before the next read) does not allocate the
      // whole tail at once (§7.3.2.2 / §8.10 R3). Reading a chunk is safe:
      // per-line commit only advances the offset to the last complete
      // line within the chunk, so the remaining bytes are read on the
      // next live `change` / reconcile tick.
      const delta = currentSize - previousPosition
      const readLength = Math.min(delta, HANDLE_FILE_READ_CHUNK_BYTES)
      const buffer = this.fs.readBytesSync(filePath, previousPosition, readLength)

      // §7.3.4 fragment-buffering: Claude Code appends JSONL while
      // writing, so the incremental delta can end mid-line (trailing
      // partial line). Process only up to the LAST newline, and never
      // advance filePositions past a partial line — otherwise the partial
      // line is lost forever once it completes (the next read starts past
      // it). If the delta has no newline at all, emit nothing and hold the
      // offset (the line is completed on a later change / reconcile tick).
      const lastNewline = buffer.lastIndexOf(0x0a) // '\n'
      if (lastNewline === -1) {
        // No complete line in this chunk. Two sub-cases:
        // (a) short read (readLength < cap): the line is still being
        //     appended — hold the offset and read it next tick.
        // (b) full-chunk read with no newline: a single line exceeds the
        //     chunk cap. This is pathological — real Claude Code JSONL
        //     lines are tiny, and §8.10 R3 explicitly leaves oversized
        //     handling to implementation judgment. We advance the offset
        //     by exactly one chunk and warn. This keeps each tick's work
        //     and memory strictly bounded (no synchronous scan-to-EOF that
        //     could block the event loop) at the cost of dropping a single
        //     >16 MiB line as unparseable fragments. We deliberately
        //     prefer bounded progress over either a permanent stall or an
        //     unbounded full-file scan; a genuinely huge single line is
        //     outside the normal session-JSONL contract.
        if (readLength >= HANDLE_FILE_READ_CHUNK_BYTES) {
          watcherLogger.warn(
            { filePath, chunkBytes: HANDLE_FILE_READ_CHUNK_BYTES },
            'Single JSONL line exceeds the read-chunk cap; advancing one chunk (oversized line, §8.10 R3)',
          )
          this.filePositions.set(filePath, previousPosition + readLength)
        }
        return
      }

      // Work on the byte buffer directly so the offset cursor stays exact
      // even with multi-byte UTF-8 content. `lineStartByte` is the byte
      // offset (relative to the start of this delta) of the current line's
      // first byte; `cursor` (absolute) advances to the end of each
      // committed line.
      let lineStartByte = 0
      for (let i = 0; i <= lastNewline; i++) {
        if (buffer[i] !== 0x0a) continue
        // Line bytes are [lineStartByte, i); the '\n' at i is consumed
        // into the committed offset.
        const lineBuf = buffer.subarray(lineStartByte, i)
        const lineEndOffset = previousPosition + i + 1
        lineStartByte = i + 1

        const line = lineBuf.toString('utf-8').trim()
        if (!line) {
          // Empty line: nothing to emit, but commit the offset so we do
          // not re-scan it.
          this.filePositions.set(filePath, lineEndOffset)
          continue
        }

        // Extract agent ID from agent-setting event
        try {
          const raw = JSON.parse(line)
          if (raw.type === 'agent-setting' && raw.agentSetting) {
            this.sessionManager.setAgentId(sessionId, raw.agentSetting)
          }
        } catch { /* ignore parse failure */ }

        const events = parseLine(line, sessionId)
        if (events.length > 0) {
          // `historical` keeps a restored (pre-existing-on-startup) line
          // from updating `status`. Stats / new_event still
          // run inside addEvents, so the session still surfaces in the list.
          this.sessionManager.addEvents(sessionId, events, { historical })
        }

        // §7.3.4 per-line commit boundary: advance the offset only after
        // addEvents has completed for this line. If a later line throws,
        // the offset is already past the committed lines, so a retry
        // (next change / reconcile tick) replays only the failed line
        // onward — committed lines are not re-emitted.
        //
        // Granularity contract (§7.3.4 / §8.10 R1, by design): the atomic
        // retry unit is "one completed line's addEvents call", NOT the
        // individual events parseLine fans the line into. addEvents emits
        // those events sequentially, so a listener that throws partway
        // leaves the line's earlier events applied while the offset is
        // still before this line — the retry re-applies the whole line
        // (at-least-once for the failing line only). Completed lines stay
        // exactly-once. Full event-granularity exactly-once would require
        // a downstream dedupe key and is intentionally out of scope for
        // this fix (§8.10 R1).
        this.filePositions.set(filePath, lineEndOffset)
      }

      // Restoration latch release: once this read has
      // committed the offset all the way to the current EOF on a newline
      // boundary, every byte that existed when restoration began has been
      // replayed (as historical). The file leaves the restoring set so the
      // NEXT append — genuinely-live activity — updates `status` normally
      // (INV-2). If the read stopped at a held partial line (offset <
      // currentSize, path B), the file stays restoring so the completion
      // line on the next `change` is still treated as restored (INV-1
      // priority: a pre-existing terminal line must not flip status).
      if (this.filePositions.get(filePath) === currentSize) {
        this.restoringFiles.delete(filePath)
      }

      // Processed without throwing: clear any prior failure marker so a
      // file that recovers logs its next failure (if any) at error level
      // again.
      this.failedFiles.delete(filePath)
    } catch (err) {
      // Log the first failure for a given file at error level, then
      // suppress repeats to debug. The reconcile scan revisits a file
      // every tick while it stays unread / grown, so a persistently
      // broken `.jsonl` would otherwise emit the same error forever
      // (unbounded log growth from one bad entry).
      if (this.failedFiles.has(filePath)) {
        watcherLogger.debug({ err, filePath }, 'File processing error (repeated, suppressed)')
      } else {
        this.failedFiles.add(filePath)
        watcherLogger.error({ err, filePath }, 'File processing error')
      }
    }
  }

  // --- Startup self-verify (§8.6.1, fail-loud observability) ---

  /**
   * After the live watch reaches `ready`, actively verify that the raw
   * `add` subscription is alive by exclusively creating a non-.jsonl
   * marker file in the sessions dir and waiting for its add event
   * (§8.6.1). Non-blocking: the result is logged only and never blocks or
   * refuses startup (§8.6 non-destructive route). Only verifies "the
   * subscription was alive at startup" — continuous coverage is the
   * reconciliation scan's job.
   */
  private runSelfVerify(watchDir: string): void {
    if (this.selfVerifyDone) return

    // Only when the sessions dir exists (§8.6.1 timing). In absent-dir
    // startup the dir may not be dug yet at ready time; defer WITHOUT
    // consuming the one-shot latch, so a later `ready` (after the
    // absent-dir reconcile transitions to live watching) can still run
    // self-verify once. Setting the latch here would permanently skip
    // verification for the rest of the process even though none ran.
    if (!this.fs.existsSync(watchDir)) {
      watcherLogger.debug('Self-verify deferred: sessions dir not present at ready')
      return
    }

    const markerPath = join(watchDir, `.kovitoboard-watch-selftest-${randomUUID()}`)

    let settled = false
    const cleanup = () => {
      this.selfVerifyObserver = null
      if (this.selfVerifyTimer) {
        clearTimeout(this.selfVerifyTimer)
        this.selfVerifyTimer = null
      }
      try {
        this.fs.unlinkSync(markerPath)
      } catch {
        // swallow: already removed / race
      }
    }

    // Install the observer and arm the timeout BEFORE creating the marker
    // file. If the watch implementation delivers the marker's `add`
    // synchronously (or otherwise before the write call returns), arming
    // the observer first ensures the event is not missed and a false
    // "subscription may be dead" error is not logged. The observer matches
    // by exact path, so installing it early cannot spuriously match
    // another file's add.
    this.selfVerifyObserver = (addedPath: string) => {
      if (settled) return
      if (addedPath !== markerPath) return
      settled = true
      watcherLogger.info('Self-verify passed: watcher add subscription is alive')
      cleanup()
    }
    this.selfVerifyTimer = setTimeout(() => {
      if (settled) return
      settled = true
      // fail-loud: error level. The add subscription may be dead; the
      // reconciliation scan remains as a net (§8.6.1.2) — but only if it
      // is enabled. With reconcileInterval <= 0 the operator opted out of
      // the scan, so the message must NOT claim a safety net that is off
      // (misleading during incident response).
      const reconcileActive = this.reconcileInterval > 0
      watcherLogger.error(
        { markerPath, reconcileActive },
        reconcileActive
          ? 'Self-verify timed out: watcher add subscription may be dead. ' +
              'Reconciliation scan remains active as a safety net.'
          : 'Self-verify timed out: watcher add subscription may be dead. ' +
              'Reconciliation scan is DISABLED (reconcileInterval <= 0), so there is ' +
              'no safety net — new sessions may go undetected.',
      )
      cleanup()
    }, SELF_VERIFY_TIMEOUT_MS)
    this.selfVerifyTimer.unref?.()

    // Exclusive create (O_CREAT | O_EXCL via 'wx'). EEXIST → skip with
    // warn (do not error: this is not proof of degrade). The marker has
    // no .jsonl extension so it is never registered as a session. On
    // failure, tear down the observer/timer we armed above and leave the
    // one-shot latch UNCONSUMED so a later `ready` (e.g. the
    // fallback-polling watcher) can retry — a single transient write
    // failure should not permanently skip verification.
    try {
      this.fs.writeFileSync(markerPath, '', { flag: 'wx', mode: 0o600 })
    } catch (err) {
      watcherLogger.warn({ err, markerPath }, 'Self-verify skipped: could not create marker file')
      settled = true
      cleanup()
      return
    }

    // Verification has actually started (observer armed + marker created):
    // consume the one-shot latch so duplicate `ready` events do not start
    // a second concurrent verification.
    this.selfVerifyDone = true
  }
}
