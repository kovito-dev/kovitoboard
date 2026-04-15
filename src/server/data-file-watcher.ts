/**
 * data-file-watcher.ts — Utility for detecting external changes to data files
 *
 * A general-purpose file watching mechanism for automatically updating in-memory
 * state without server restart when agents directly modify JSON files.
 *
 * === For developers adding a new data Manager ===
 *
 * When creating a new Manager that manages state via JSON files,
 * always integrate file watching using this class.
 *
 * Steps:
 *   1. Call DataFileWatcher.register() in the Manager constructor
 *   2. Call notifySelfWrite() before save()
 *   3. Perform load() + event emission in the callback
 *
 * Example:
 *   constructor(workspaceDir: string, watcher: DataFileWatcher) {
 *     this.filePath = join(workspaceDir, 'data', 'my-data.json')
 *     watcher.register(this.filePath, () => {
 *       this.load()
 *       this.emit('my_data_update', { action: 'reload' })
 *     })
 *   }
 *
 *   private save(): void {
 *     this.watcher.notifySelfWrite(this.filePath)
 *     fs.writeFileSync(this.filePath, ...)
 *   }
 */

import type { FileAccessLayer, WatchHandle } from './fs-layer'

interface WatchEntry {
  /** Callback invoked on external change */
  onReload: () => void
  /** Whether a self-write just occurred (if true, ignore the next change event) */
  selfWritePending: boolean
  /** Debounce timer */
  debounceTimer: ReturnType<typeof setTimeout> | null
}

/** Debounce interval (ms): coalesces consecutive writes by agents */
const DEBOUNCE_MS = 300

export class DataFileWatcher {
  private entries = new Map<string, WatchEntry>()
  private watchHandles: WatchHandle[] = []
  private usePolling: boolean
  private pollInterval: number
  private fs: FileAccessLayer

  constructor(
    fs: FileAccessLayer,
    options?: { usePolling?: boolean; pollInterval?: number }
  ) {
    this.fs = fs
    this.usePolling = options?.usePolling ?? true
    this.pollInterval = options?.pollInterval ?? 1500
  }

  /**
   * Register a file to watch.
   *
   * @param filePath Absolute path of the file to watch
   * @param onReload Callback invoked when an external change is detected
   */
  register(filePath: string, onReload: () => void): void {
    this.entries.set(filePath, {
      onReload,
      selfWritePending: false,
      debounceTimer: null,
    })

    const handle = this.fs.watch(
      filePath,
      (event) => {
        if (event.type === 'change') {
          this.handleChange(event.path)
        } else if (event.type === 'error') {
          console.error(`[DataFileWatcher] watch error: ${filePath}`, event.error)
        }
      },
      {
        usePolling: this.usePolling,
        pollInterval: this.pollInterval,
        ignoreInitial: true,
      }
    )

    this.watchHandles.push(handle)
    console.log(`[DataFileWatcher] registered: ${filePath}`)
  }

  /**
   * Notify of a self-write.
   * Call before save() to ignore the immediately following change event.
   */
  notifySelfWrite(filePath: string): void {
    const entry = this.entries.get(filePath)
    if (entry) {
      entry.selfWritePending = true
    }
  }

  /** Stop all watchers */
  close(): void {
    for (const h of this.watchHandles) {
      h.close()
    }
    this.watchHandles = []
    // Clear debounce timers
    for (const entry of this.entries.values()) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer)
      }
    }
    this.entries.clear()
  }

  private handleChange(filePath: string): void {
    const entry = this.entries.get(filePath)
    if (!entry) return

    // Skip if this is a self-write
    if (entry.selfWritePending) {
      entry.selfWritePending = false
      return
    }

    // Debounce: coalesce consecutive changes
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      console.log(`[DataFileWatcher] external change detected: ${filePath}`)
      try {
        entry.onReload()
      } catch (err) {
        console.error(`[DataFileWatcher] reload error: ${filePath}`, err)
      }
    }, DEBOUNCE_MS)
  }
}
