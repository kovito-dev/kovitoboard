/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { tmuxLogger, redactSensitiveTokens } from './logger'
import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, resolve, join } from 'path'
import { scrubNestedDetectionEnv } from './nested-detection-env'

/**
 * Browser-control read round-trip PoC (throwaway, env-gated).
 *
 * When KBEXT_BROWSER_CONTROL_POC=1, builds the per-invocation flags that
 * inject a stdio MCP server exposing the read-only `read_page_title` tool.
 * The server script is shipped under the repo's `scripts/poc/` and resolved
 * relative to this module so it works both in dev (tsx, `src/server/`) and
 * in a compiled build (`dist/server/`) — both directories sit two levels
 * below the repo root. Returns an empty array when the flag is unset, so the
 * launch arguments — and therefore the behaviour — are byte-for-byte
 * identical to a normal build.
 */
function buildBrowserControlPocArgs(): string[] {
  if (process.env.KBEXT_BROWSER_CONTROL_POC !== '1') return []
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, '../..')
  const mcpScript = join(repoRoot, 'scripts', 'poc', 'browser-control-mcp.mjs')
  const port = process.env.PORT || '3001'
  const endpoint = `http://127.0.0.1:${port}/_poc/browser-control/action`
  const mcpConfig = JSON.stringify({
    mcpServers: {
      'browser-control': {
        command: process.execPath,
        args: [mcpScript],
        env: { KB_BC_ENDPOINT: endpoint },
      },
    },
  })
  return [
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__browser-control__read_page_title',
  ]
}

interface ManagedProcess {
  id: string
  process: ChildProcess
  sessionId: string | null
  agentId?: string
  status: 'starting' | 'running' | 'completed' | 'error'
  startedAt: string
  stdout: string
  stderr: string
}

/**
 * Maximum number of characters of a single Claude-CLI stderr chunk
 * that the per-chunk debug log line carries verbatim. Anything past
 * this is replaced with a `…[truncated N chars]` marker; the
 * untruncated text continues to live on `managed.stderr` so
 * post-mortem and the close-handler `stdout += stderr` path are
 * unaffected.
 *
 * Picked to keep a per-chunk log line comfortably under one terminal
 * page while still showing the leading error context every operator
 * actually reads.
 */
const STDERR_LOG_PREVIEW_CHARS = 200

/**
 * Manages spawning and lifecycle of Claude CLI processes.
 *
 * - Send to existing session: claude --print --resume <sessionId> "<message>"
 * - Start new session: claude --print [--agent <agentId>] "<message>"
 *
 * Since --print mode completes in one turn, a new process is spawned for each message.
 * The Claude CLI writes to JSONL files, which the existing watcher detects and reflects in the UI.
 */
export class ClaudeBridge extends EventEmitter {
  private processes = new Map<string, ManagedProcess>()
  private defaultCwd: string

  /**
   * @param defaultCwd Default working directory for session launch.
   *                   Usually the project root, passed by the caller.
   */
  constructor(defaultCwd: string) {
    super()
    // process.cwd() returns the server startup directory, so the caller must explicitly specify
    this.defaultCwd = defaultCwd
  }

  /**
   * Send a message to an existing session.
   * @param cwd Path to the project where the session was created (required because --resume identifies the project from cwd)
   */
  sendToSession(sessionId: string, message: string, cwd?: string): string {
    const args = [
      '--print',
      '--resume', sessionId,
      message
    ]

    return this.spawnClaude(args, cwd || this.defaultCwd, sessionId)
  }

  /**
   * Start a new session.
   */
  startNewSession(message: string, agentId?: string, cwd?: string): string {
    const args = ['--print']

    if (agentId) {
      args.push('--agent', agentId)
    }

    // PoC-only MCP injection (no-op unless KBEXT_BROWSER_CONTROL_POC=1).
    // Pushed before the positional message, which must remain the last arg.
    args.push(...buildBrowserControlPocArgs())

    args.push(message)

    return this.spawnClaude(args, cwd || this.defaultCwd, null, agentId)
  }

  /**
   * Get the status of a process.
   */
  getProcess(processId: string): ManagedProcess | undefined {
    return this.processes.get(processId)
  }

  /**
   * Backfill the `sessionId` of a process once the watcher resolves it.
   * A `startNewSession` process is spawned with `sessionId: null` (the
   * id is only known after Claude writes the JSONL), so callers that
   * later learn the mapping — e.g. the external-client launch
   * correlation — can attach it here so `process_end` consumers that
   * key on `getProcess(id).sessionId` (the ext subscription filter)
   * resolve correctly. No-op if the process has already been cleaned up.
   */
  setSessionId(processId: string, sessionId: string): void {
    const managed = this.processes.get(processId)
    if (managed) managed.sessionId = sessionId
  }

  /**
   * Number of active processes.
   */
  getActiveCount(): number {
    let count = 0
    for (const p of this.processes.values()) {
      if (p.status === 'starting' || p.status === 'running') count++
    }
    return count
  }

  /**
   * Common routine to spawn a Claude CLI process.
   */
  private spawnClaude(
    args: string[],
    cwd: string,
    sessionId: string | null,
    agentId?: string
  ): string {
    const processId = randomUUID()

    // Do not log the message body (last argument). Emit `cwd` as a
    // structured field on the same record instead of a second log
    // line so it is searchable as `cwd` (and rides through the
    // logger's redaction layer once, not twice). The msg-string is
    // also redacted by the logger's `hooks.logMethod` wrapper, so
    // an Anthropic key inside `safeArgs` does not leak even if the
    // CLI starts to echo one in the future.
    const safeArgs = args.slice(0, -1).join(' ')
    tmuxLogger.info(
      { cwd },
      `[claude-bridge] Starting: claude ${safeArgs} <message:${args[args.length - 1].length}chars>`,
    )

    // Strip Claude Code's nested-detection signal vars so the child
    // `claude` does not mistake itself for a nested instance and skip
    // writing its transcript. `ANTHROPIC_*` auth vars are preserved —
    // see `session-management.md` §8.9 (SSOT) and the shared predicate.
    const env = scrubNestedDetectionEnv(process.env)

    const child = spawn('claude', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const managed: ManagedProcess = {
      id: processId,
      process: child,
      sessionId,
      agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
    }

    this.processes.set(processId, managed)

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      managed.stdout += text
      this.emit('output', processId, text)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      managed.stderr += text
      // Output stderr as debug information
      // Per-chunk stderr at debug, not info: a noisy or failing
      // subprocess can otherwise burn through the retention budget
      // and bury actionable events. Operators can still reach the
      // chunks by enabling KOVITOBOARD_DEBUG.
      //
      // Truncate per-chunk stderr to STDERR_LOG_PREVIEW_CHARS so a
      // single noisy chunk does not push a multi-KB blob into the
      // log line. The full buffer remains on `managed.stderr` for
      // post-mortem inspection (and for the close-handler that
      // appends it to stdout on non-zero exit). Token-shaped values
      // inside the surviving preview window are still redacted by
      // the logger's redaction layer.
      // Redact BEFORE truncating so a token landing across the
      // 200-char preview boundary cannot leak as a non-matching
      // fragment (e.g. `sk-ant-abc...`). Truncation is computed
      // on the redacted form, and the size marker reports the
      // original chunk size so operators still see how much was
      // dropped.
      const trimmed = text.trim()
      const redacted = redactSensitiveTokens(trimmed)
      const preview = redacted.length > STDERR_LOG_PREVIEW_CHARS
        ? `${redacted.slice(0, STDERR_LOG_PREVIEW_CHARS)}…[truncated ${trimmed.length - STDERR_LOG_PREVIEW_CHARS} chars of original]`
        : redacted
      tmuxLogger.debug(`[claude-bridge] stderr(${processId.slice(0, 8)}): ${preview}`)
    })

    child.on('close', (code) => {
      if (code === 0) {
        managed.status = 'completed'
        tmuxLogger.info(`[claude-bridge] Completed(${processId.slice(0, 8)}): exit ${code}`)
      } else {
        managed.status = 'error'
        managed.stdout += managed.stderr
        tmuxLogger.error(`[claude-bridge] Error(${processId.slice(0, 8)}): exit ${code}`)
      }
      this.emit('process_end', processId, managed.status, code)

      // Clean up completed processes after 10 minutes
      setTimeout(() => {
        this.processes.delete(processId)
      }, 10 * 60 * 1000)
    })

    child.on('error', (err) => {
      managed.status = 'error'
      // Whitelist a narrow subset of the Error rather than handing
      // pino the whole object: Node's child_process spawn errors
      // carry `spawnargs`, which on this code path includes the
      // Claude message body as the final argv entry. Logging the raw
      // error would persist that body into server.log even though
      // the rest of this file deliberately avoids it (see L104 where
      // we log a length only).
      const safeErr = {
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
        code: (err as NodeJS.ErrnoException).code,
        path: (err as NodeJS.ErrnoException).path,
      }
      tmuxLogger.error(
        { err: safeErr },
        `[claude-bridge] Process error(${processId.slice(0, 8)})`,
      )
      this.emit('process_end', processId, 'error', -1)
    })

    return processId
  }
}
