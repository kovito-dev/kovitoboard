/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
  appendFileSync as fsAppendFileSync,
  renameSync as fsRenameSync,
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
  mkdirSync as fsMkdirSync,
  unlinkSync as fsUnlinkSync,
  rmSync as fsRmSync,
  symlinkSync as fsSymlinkSync,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  fsyncSync as fsFsyncSync,
  fchmodSync as fsFchmodSync,
} from 'fs'
import { dirname, basename } from 'path'
import { randomBytes } from 'crypto'
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

/** Options for `writeFileAtomic`. */
export interface WriteFileAtomicOptions {
  /**
   * File mode for the destination file. Defaults to `0o600` so the
   * captured content (which can include onboarding state, recipe
   * history entries, etc.) is not world-readable on shared hosts.
   */
  mode?: number
  /**
   * When true (default), call `fsync` on the temp file before the
   * rename. This guarantees that the new content has been flushed to
   * disk before it becomes visible. Disable only when the caller has
   * already proven the durability cost is unacceptable.
   */
  fsync?: boolean
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
  /**
   * Atomically replace the destination file's contents. The file is
   * either the previous version or the new version, never half-written
   * — useful for JSON stores where a partial write would surface as a
   * `JSON.parse` failure on the next load. Backed by a same-directory
   * temp file + `fsync` (optional) + POSIX `rename(2)`.
   */
  writeFileAtomic(
    path: string,
    content: string | Buffer,
    options?: WriteFileAtomicOptions
  ): void
  /**
   * Append content to a file (create if missing). Used by JSONL stores
   * where each call writes one line. Avoids the read-modify-write race
   * that `writeFileSync` would have on a shared append target.
   */
  appendFileSync(
    path: string,
    content: string | Buffer,
    encoding?: BufferEncoding
  ): void
  /** Rename a file. Used internally by atomic writes and by `.corrupted` fallback paths. */
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  /**
   * Remove a path. With `{ recursive: true }` removes a directory and
   * its contents (mirrors `fs.rmSync`'s recursive flag). With
   * `{ force: true }` swallows ENOENT so the call is idempotent —
   * useful for "remove if exists" cleanup paths.
   */
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void

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

  writeFileAtomic(
    path: string,
    content: string | Buffer,
    options?: WriteFileAtomicOptions
  ): void {
    // Same-directory rename is the only atomic-replace path POSIX
    // gives us — `rename(2)` across devices falls back to copy+unlink
    // and loses the atomicity guarantee. So the temp file MUST be a
    // sibling of the destination.
    const dir = dirname(path)
    const base = basename(path)
    // pid + 8 hex chars from /dev/urandom: cheap collision avoidance
    // when multiple processes race to write the same destination
    // (e.g. two browser tabs saving settings concurrently).
    const tempName = `${base}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    const tempPath = `${dir}/${tempName}`
    const wantFsync = options?.fsync !== false
    // Mode resolution: caller-supplied wins; otherwise preserve the
    // existing file's mode (so an existing 0o644 menu.ts or a custom-
    // chmodded manifest is not silently downgraded to 0o600); fall
    // back to 0o600 only for genuinely new files.
    let mode: number
    if (options?.mode !== undefined) {
      mode = options.mode
    } else if (fsExistsSync(path)) {
      try {
        mode = fsStatSync(path).mode & 0o777
      } catch {
        mode = 0o600
      }
    } else {
      mode = 0o600
    }

    let fd: number | undefined
    try {
      // O_WRONLY | O_CREAT | O_EXCL: refuse to clobber a stale temp
      // file (whose presence would mean another writer just lost the
      // race or crashed mid-write — we cannot safely reuse it).
      fd = fsOpenSync(tempPath, 'wx', mode)
      // The mode passed to `open(2)` is masked by the process umask
      // (e.g. umask 0o077 turns 0o644 into 0o600). `fchmod(2)` sets
      // the mode bits verbatim, so we apply it after open to make the
      // helper's mode contract independent of whatever umask the
      // caller happened to inherit.
      fsFchmodSync(fd, mode)
      if (typeof content === 'string') {
        fsWriteFileSync(fd, content, 'utf-8')
      } else {
        fsWriteFileSync(fd, content)
      }
      if (wantFsync) {
        this._fsync(fd)
      }
      fsCloseSync(fd)
      fd = undefined
      this._rename(tempPath, path)
      // Durability of the rename itself depends on the parent
      // directory entry reaching disk, which requires an explicit
      // fsync(dirfd) on POSIX (a file fsync alone does not flush the
      // dirent that points at the new inode). Without this a
      // crash/power loss after rename can drop the entry and roll
      // back to the previous file. We swallow errors here — the
      // primary write succeeded, and platforms that disallow
      // directory fsync (notably Windows) would otherwise fail every
      // call. fsync for `--fsync=false` callers is also skipped on
      // the directory to keep the opt-out coherent.
      if (wantFsync) {
        this._fsyncDir(dir)
      }
    } catch (err) {
      // Best-effort cleanup. Either the open failed (no fd, no temp
      // file to remove), or the write/rename failed (stale temp file
      // we should remove). Suppress errors here — the original error
      // is what the caller cares about, and a leftover temp file is
      // recoverable (next successful write will rename over it).
      if (fd !== undefined) {
        try {
          fsCloseSync(fd)
        } catch {
          // already closed or invalid fd; nothing more we can do
        }
      }
      try {
        fsUnlinkSync(tempPath)
      } catch {
        // temp file may not exist (open failed) or may already be gone
      }
      throw err
    }
  }

  /**
   * Hook around `fs.renameSync`, isolated as a protected method so
   * tests can inject failure modes (ENOSPC / EXDEV) by subclassing
   * `DirectFsLayer`. ESM `vi.spyOn` cannot redefine module namespace
   * exports, so per-call indirection is the cleanest seam.
   */
  protected _rename(oldPath: string, newPath: string): void {
    fsRenameSync(oldPath, newPath)
  }

  /** Hook around `fs.fsyncSync`. See `_rename` for rationale. */
  protected _fsync(fd: number): void {
    fsFsyncSync(fd)
  }

  /**
   * Best-effort `fsync` on a directory descriptor so the freshly
   * renamed dirent reaches disk. Windows / some FUSE filesystems
   * reject `O_RDONLY` opens of directories or `fsync` on directory
   * fds — we treat any failure here as non-fatal because the primary
   * file write has already succeeded.
   */
  protected _fsyncDir(dir: string): void {
    let dirFd: number | undefined
    try {
      dirFd = fsOpenSync(dir, 'r')
      fsFsyncSync(dirFd)
    } catch {
      // best-effort; directory fsync is unsupported on some platforms
    } finally {
      if (dirFd !== undefined) {
        try {
          fsCloseSync(dirFd)
        } catch {
          // already closed; nothing to recover
        }
      }
    }
  }

  appendFileSync(
    path: string,
    content: string | Buffer,
    encoding: BufferEncoding = 'utf-8'
  ): void {
    if (typeof content === 'string') {
      fsAppendFileSync(path, content, encoding)
    } else {
      fsAppendFileSync(path, content)
    }
  }

  renameSync(oldPath: string, newPath: string): void {
    fsRenameSync(oldPath, newPath)
  }

  unlinkSync(path: string): void {
    fsUnlinkSync(path)
  }

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    fsRmSync(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    })
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
