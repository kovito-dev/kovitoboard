import { basename, dirname, join } from 'path'
import { parseLine } from './parser'
import { loadSessionAgentRecords, buildSessionAgentMap } from './agent-reader'
import { resolveProjectRoot } from './config'
import type { FileAccessLayer, WatchEvent, WatchHandle } from './fs-layer'
import type { SessionManager } from './session-manager'
import type { ViewerConfig } from './types'

/**
 * Convert a project root path to a Claude project directory name.
 * Example: "/home/user/my-project" → "-home-user-my-project"
 */
function projectPathToClaudeDirName(projectRoot: string): string {
  return projectRoot.replace(/\//g, '-')
}

export class Watcher {
  private watchHandle: WatchHandle | null = null
  // Read byte position per file
  private filePositions = new Map<string, number>()
  private claudeDir: string
  private fullConfig: ViewerConfig
  private config: ViewerConfig['watcher']
  private sessionManager: SessionManager
  private fs: FileAccessLayer

  constructor(config: ViewerConfig, sessionManager: SessionManager, fs: FileAccessLayer) {
    this.claudeDir = config.claudeDir
    this.fullConfig = config
    this.config = config.watcher
    this.sessionManager = sessionManager
    this.fs = fs
  }

  start(): void {
    // Watch only the Claude session directory corresponding to the current project
    const projectRoot = resolveProjectRoot(this.fs)
    const claudeDirName = projectPathToClaudeDirName(projectRoot)
    const projectSessionsDir = join(this.claudeDir, 'projects', claudeDirName)

    const usePolling = this.config.usePolling
    const pollInterval = this.config.pollInterval

    console.log(`[Watcher] Project root: ${projectRoot}`)
    console.log(`[Watcher] Watching: ${projectSessionsDir}`)
    console.log(`[Watcher] Mode: ${usePolling ? `polling (${pollInterval}ms)` : 'inotify (native)'}`)

    // If the directory does not exist (no sessions yet), wait for it to be created
    if (!this.fs.existsSync(projectSessionsDir)) {
      console.log(`[Watcher] Session directory not yet created. Watching parent directory and waiting.`)
      const projectsDir = join(this.claudeDir, 'projects')
      // Watch the parent directory and switch when the target directory appears
      this.watchHandle = this.fs.watch(
        projectsDir,
        (event: WatchEvent) => {
          if (event.type === 'addDir') {
            if (basename(event.path) === claudeDirName) {
              console.log(`[Watcher] Session directory detected: ${event.path}`)
              this.watchHandle?.close()
              this.watchHandle = null
              this.startWatching(projectSessionsDir, usePolling, pollInterval)
            }
          } else if (event.type === 'ready') {
            // Re-check if the directory exists at ready time
            if (this.fs.existsSync(projectSessionsDir)) {
              this.watchHandle?.close()
              this.watchHandle = null
              this.startWatching(projectSessionsDir, usePolling, pollInterval)
            } else {
              console.log('[Watcher] Initial scan complete (no sessions)')
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
      return
    }

    this.startWatching(projectSessionsDir, usePolling, pollInterval)
  }

  private startWatching(watchDir: string, usePolling: boolean, pollInterval: number): void {
    this.watchHandle = this.fs.watch(
      watchDir,
      (event: WatchEvent) => {
        if (event.type === 'add' || event.type === 'change') {
          if (event.path.endsWith('.jsonl')) this.handleFile(event.path)
        } else if (event.type === 'ready') {
          console.log('[Watcher] Initial scan complete')
          this.applyFallbackAgentMapping()
          this.sessionManager.setInitialized()
        } else if (event.type === 'error') {
          console.error('[Watcher] Error:', event.error)
          // Fall back to polling on inotify error
          if (!usePolling) {
            console.log('[Watcher] Falling back to polling due to inotify error')
            this.watchHandle?.close()
            this.watchHandle = this.fs.watch(
              watchDir,
              (ev: WatchEvent) => {
                if (ev.type === 'add' || ev.type === 'change') {
                  if (ev.path.endsWith('.jsonl')) this.handleFile(ev.path)
                } else if (ev.type === 'error') {
                  console.error('[Watcher] Fallback error:', ev.error)
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
  }

  stop(): void {
    this.watchHandle?.close()
    this.watchHandle = null
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
      console.log(`[Watcher] Fallback agent mapping applied: ${applied} sessions`)
    }
  }

  private handleFile(filePath: string): void {
    try {
      const stat = this.fs.statSync(filePath)
      const currentSize = stat.size
      const previousPosition = this.filePositions.get(filePath) || 0

      if (currentSize <= previousPosition) return

      // Session ID: filename without extension
      const sessionId = basename(filePath, '.jsonl')
      // Project path: parent directory name
      const projectPath = basename(dirname(filePath))

      // Skip files in the subagents directory (to be supported later)
      if (filePath.includes('/subagents/')) return

      this.sessionManager.ensureSession(sessionId, projectPath, filePath)

      // Incremental read (via fs-layer)
      const buffer = this.fs.readBytesSync(
        filePath,
        previousPosition,
        currentSize - previousPosition
      )

      const newContent = buffer.toString('utf-8')
      const lines = newContent.split('\n').filter((l: string) => l.trim())

      for (const line of lines) {
        // Extract agent ID from agent-setting event
        try {
          const raw = JSON.parse(line)
          if (raw.type === 'agent-setting' && raw.agentSetting) {
            this.sessionManager.setAgentId(sessionId, raw.agentSetting)
          }
        } catch { /* ignore parse failure */ }

        const events = parseLine(line, sessionId)
        if (events.length > 0) {
          this.sessionManager.addEvents(sessionId, events)
        }
      }

      this.filePositions.set(filePath, currentSize)
    } catch (err) {
      console.error(`[Watcher] File processing error: ${filePath}`, err)
    }
  }
}
