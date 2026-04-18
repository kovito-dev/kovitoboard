/**
 * File access abstraction layer
 *
 * KovitoBoard may require MCP-based file access for future Claude Code Plugin
 * support (v0.2.0+). Therefore, all direct fs calls are eliminated from core
 * functionality and consolidated through this layer.
 *
 * v0.1.0 provides only DirectFsLayer (default implementation using Node.js fs / chokidar).
 * v0.1.0 provides only Sync APIs (since all existing code is synchronous).
 * Promise-based APIs will be added in v0.2.0+ when Plugin support is needed.
 *
 * For detailed design rationale, see kovitoboard-dev docs/design/v0.1.0-fs-layer-notes.md.
 */

import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
  mkdirSync as fsMkdirSync,
  unlinkSync as fsUnlinkSync,
  symlinkSync as fsSymlinkSync,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
} from 'fs'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'

// --- Type definitions ---

/** Abstracted stat info (minimal fields extracted from Node.js fs.Stats) */
export interface FileStat {
  size: number
  mtime: Date
  mtimeMs: number
}

/** Abstracted watch event (subset of chokidar) */
export type WatchEvent =
  | { type: 'add'; path: string }
  | { type: 'change'; path: string }
  | { type: 'addDir'; path: string }
  | { type: 'unlink'; path: string }
  | { type: 'ready' }
  | { type: 'error'; error: unknown }

/** Watch handle (provides close only) */
export interface WatchHandle {
  close(): void
}

/** Watch options (subset of chokidar) */
export interface WatchOptions {
  usePolling?: boolean
  pollInterval?: number
  ignoreInitial?: boolean
  depth?: number
}

// --- FileAccessLayer interface ---

/**
 * File access abstraction layer
 *
 * v0.1.0 provides only Sync APIs.
 * This decision avoids behavioral changes since all existing code is synchronous.
 * Promise-based APIs will be added in v0.2.0+ when needed.
 */
export interface FileAccessLayer {
  // --- Read ---
  readFileSync(path: string, encoding?: BufferEncoding): string
  /** Low-level byte-range read (for watcher.ts JSONL differential parsing) */
  readBytesSync(path: string, offset: number, length: number): Buffer

  // --- Write ---
  writeFileSync(path: string, content: string | Buffer, encoding?: BufferEncoding): void
  unlinkSync(path: string): void

  // --- Metadata ---
  existsSync(path: string): boolean
  statSync(path: string): FileStat
  readdirSync(path: string): string[]
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  /** Symbolic link creation (for agent-ref setup etc.) */
  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void

  // --- Watch ---
  watch(
    path: string,
    handler: (event: WatchEvent) => void,
    options?: WatchOptions
  ): WatchHandle
}

// --- DirectFsLayer implementation ---

/**
 * Default implementation that directly calls Node.js standard fs / chokidar.
 * Only this implementation is used in v0.1.0.
 */
export class DirectFsLayer implements FileAccessLayer {
  readFileSync(path: string, encoding: BufferEncoding = 'utf-8'): string {
    return fsReadFileSync(path, encoding)
  }

  readBytesSync(path: string, offset: number, length: number): Buffer {
    const buffer = Buffer.alloc(length)
    const fd = fsOpenSync(path, 'r')
    try {
      fsReadSync(fd, buffer, 0, length, offset)
    } finally {
      fsCloseSync(fd)
    }
    return buffer
  }

  writeFileSync(
    path: string,
    content: string | Buffer,
    encoding: BufferEncoding = 'utf-8'
  ): void {
    if (typeof content === 'string') {
      fsWriteFileSync(path, content, encoding)
    } else {
      fsWriteFileSync(path, content)
    }
  }

  unlinkSync(path: string): void {
    fsUnlinkSync(path)
  }

  existsSync(path: string): boolean {
    return fsExistsSync(path)
  }

  statSync(path: string): FileStat {
    const s = fsStatSync(path)
    return { size: s.size, mtime: s.mtime, mtimeMs: s.mtimeMs }
  }

  readdirSync(path: string): string[] {
    return fsReaddirSync(path)
  }

  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    fsMkdirSync(path, options)
  }

  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void {
    fsSymlinkSync(target, path, type)
  }

  watch(
    path: string,
    handler: (event: WatchEvent) => void,
    options?: WatchOptions
  ): WatchHandle {
    const watcher: FSWatcher = chokidarWatch(path, {
      usePolling: options?.usePolling,
      interval: options?.usePolling ? options?.pollInterval : undefined,
      ignoreInitial: options?.ignoreInitial,
      depth: options?.depth,
    })

    watcher.on('add', (p) => handler({ type: 'add', path: p }))
    watcher.on('change', (p) => handler({ type: 'change', path: p }))
    watcher.on('addDir', (p) => handler({ type: 'addDir', path: p }))
    watcher.on('unlink', (p) => handler({ type: 'unlink', path: p }))
    watcher.on('ready', () => handler({ type: 'ready' }))
    watcher.on('error', (error) => handler({ type: 'error', error }))

    return {
      close() {
        void watcher.close()
      },
    }
  }
}
