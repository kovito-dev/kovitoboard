/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { tmuxLogger } from './logger'
import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

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

    // Do not log the message body (last argument)
    const safeArgs = args.slice(0, -1).join(' ')
    tmuxLogger.info(`[claude-bridge] Starting: claude ${safeArgs} <message:${args[args.length - 1].length}chars>`)
    tmuxLogger.info(`[claude-bridge] cwd: ${cwd}`)

    // Remove Claude Code related env vars to avoid nested instance detection
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC')) {
        delete env[key]
      }
    }

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
      tmuxLogger.info(`[claude-bridge] stderr(${processId.slice(0, 8)}): ${text.trim()}`)
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
      tmuxLogger.error({ err }, `[claude-bridge] Process error(${processId.slice(0, 8)})`)
      this.emit('process_end', processId, 'error', -1)
    })

    return processId
  }
}
