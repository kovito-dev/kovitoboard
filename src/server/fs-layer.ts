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

import { constants as fsConstants } from 'fs'
import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  appendFileSync as fsAppendFileSync,
  renameSync as fsRenameSync,
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  unlinkSync as fsUnlinkSync,
  rmSync as fsRmSync,
  symlinkSync as fsSymlinkSync,
  realpathSync as fsRealpathSync,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  fsyncSync as fsFsyncSync,
  fstatSync as fsFstatSync,
  fchmodSync as fsFchmodSync,
  fchownSync as fsFchownSync,
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

/**
 * Abstracted lstat info — superset of `FileStat` with the type
 * predicates needed to defend against symlinks and non-regular files
 * in security-sensitive write paths (e.g. CLAUDE.md guidance
 * injection where a planted symlink could otherwise redirect a read /
 * write outside the trusted project root).
 *
 * `lstat` does NOT follow symlinks, so `isSymbolicLink: true` reflects
 * the link itself rather than its target. Callers that want to allow
 * existing files at a security-sensitive path should reject the
 * non-regular cases (`!isFile || isSymbolicLink`) before any
 * follow-up `readFileSync` / `writeFileAtomic` runs.
 */
export interface FileLstat extends FileStat {
  isSymbolicLink: boolean
  isFile: boolean
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
   * File mode for the destination file.
   *
   * Resolution rules when this option is omitted:
   *
   * - The destination already exists → reuse the existing file's
   *   mode verbatim (so an existing 0o644 menu.ts stays 0o644 after
   *   a rewrite, instead of being silently downgraded).
   * - The destination is new → create with mode 0o600 *subject to*
   *   the process umask, so deployment-level hardening (for example
   *   `umask 077`) keeps applying.
   *
   * When this option is supplied the requested mode is set
   * verbatim via `fchmod(2)`, bypassing the umask. Callers that pass
   * an explicit mode are presumed to know what they want; if they
   * intended a hardened mode they can pass `0o600` directly, and if
   * they intended a permissive one (e.g. `0o644` for a shared
   * config) the helper does not silently strip bits.
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
  /**
   * Read a file with two guarantees enforced via `fstat` on the open
   * file descriptor:
   *
   *   1. **regular-file gate**: `fstat.isFile()` must hold. FIFOs,
   *      devices, directories, and sockets are rejected with
   *      `{ notRegular: true }` so the caller's prior `lstat` check
   *      cannot be undone by a TOCTOU swap (CodeX attempt 18 —
   *      validate-then-open race).
   *   2. **size cap**: `fstat.size` must be within `maxBytes`. An
   *      oversized file is rejected with `{ oversized: true }` and no
   *      content is buffered (CodeX attempt 16 / 17 — resource
   *      exhaustion).
   *
   * Both checks run against the SAME file descriptor as the read, so
   * an attacker cannot swap or grow the file between validation and
   * load. Implementations MUST close the fd in a `finally` branch so
   * a thrown read does not leak descriptors.
   *
   * Throws on `open`/`stat`/`read` failures other than the gates —
   * the caller treats those as `read-error`.
   */
  readFileBoundedSync(
    path: string,
    maxBytes: number,
  ):
    | { oversized: false; notRegular: false; content: string }
    | { oversized: true; notRegular: false; size: number }
    | { oversized: false; notRegular: true }

  // --- Write ---
  writeFileSync(path: string, content: string | Buffer, encoding?: BufferEncoding): void
  /**
   * Atomically replace the destination file's contents.
   *
   * Scope: this helper is intended for KB-internal JSON / text stores
   * under `.kovitoboard/` and `app/<appId>/` — files KB itself
   * creates and owns. It is **not** a generic file-replacement helper:
   * because it publishes via `rename(2)` over a fresh inode, only the
   * mode bits and (best-effort) owner/group of the previous file are
   * carried over. POSIX ACLs, extended attributes, and security
   * labels are lost by design. For generic file replacement that
   * needs full metadata preservation, prefer an in-place helper or
   * `cp --preserve=all` style routine.
   *
   * String content is always written as UTF-8 (matching how callers
   * stringify JSON); Buffer content is written verbatim.
   *
   * Backed by a same-directory temp file + `fsync` (optional) + POSIX
   * `rename(2)`. The file is either the previous version or the new
   * version, never half-written — useful for JSON stores where a
   * partial write would surface as a `JSON.parse` failure on the
   * next load.
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
  /**
   * `lstat`-based metadata. Unlike `statSync`, this does NOT follow
   * symlinks, so the result reports the link itself (`isSymbolicLink:
   * true`) rather than the link target. Use this in security-sensitive
   * write paths to reject planted symlinks / FIFOs / device files
   * before any follow-up `readFileSync` / `writeFileAtomic` chain
   * inadvertently leaves the trusted project root.
   */
  lstatSync(path: string): FileLstat
  readdirSync(path: string): string[]
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  /** Symbolic link creation (for agent-ref setup etc.) */
  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void
  /**
   * Resolve `path` to its canonical absolute form, following every
   * symbolic link in the chain and removing `.` / `..` segments.
   *
   * Used by security-sensitive callers (`recipe-exporter.scanAppDirectory`
   * etc.) to enforce that a derived path stays inside the trusted root
   * even when an intermediate component is a planted symlink. Throws
   * `ENOENT` when any link in the chain is dangling, so callers should
   * either confirm `existsSync` first or catch the error.
   */
  realpathSync(path: string): string

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

  readFileBoundedSync(
    path: string,
    maxBytes: number,
  ):
    | { oversized: false; notRegular: false; content: string }
    | { oversized: true; notRegular: false; size: number }
    | { oversized: false; notRegular: true } {
    // Open with O_NONBLOCK so a FIFO target does not stall the
    // event loop waiting for a writer (CodeX attempt 20 —
    // blocking I/O). Once we observe `isFile() === false` we
    // bail; otherwise the non-blocking flag has no effect on a
    // regular file read.
    const fd = fsOpenSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    try {
      const stat = fsFstatSync(fd)
      if (!stat.isFile()) {
        return { oversized: false, notRegular: true }
      }
      if (stat.size > maxBytes) {
        return { oversized: true, notRegular: false, size: stat.size }
      }
      const buffer = Buffer.alloc(stat.size)
      let totalRead = 0
      while (totalRead < stat.size) {
        const bytesRead = fsReadSync(
          fd,
          buffer,
          totalRead,
          stat.size - totalRead,
          totalRead,
        )
        if (bytesRead <= 0) break
        totalRead += bytesRead
      }
      return {
        oversized: false,
        notRegular: false,
        content: buffer.subarray(0, totalRead).toString('utf-8'),
      }
    } finally {
      fsCloseSync(fd)
    }
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
    // Mode resolution falls into three branches:
    //
    // - explicitMode !== null: caller asked for an exact mode. Pass
    //   it to `open` *and* `fchmod` so umask cannot strip bits the
    //   caller wanted (see Finding-6 lineage).
    // - existing file, no explicit mode: reuse the existing mode via
    //   `fchmod` so a rewrite does not silently downgrade an existing
    //   0o644 menu.ts to 0o600.
    // - new file, no explicit mode: open with 0o600 and DO NOT call
    //   `fchmod`. That keeps the process umask in force (deployment
    //   hardening such as `umask 077` is the operator's contract,
    //   not ours to bypass for new files).
    const explicitMode = options?.mode ?? null
    let preservedMode: number | null = null
    let preservedUid: number | null = null
    let preservedGid: number | null = null
    if (explicitMode === null && fsExistsSync(path)) {
      try {
        const st = fsStatSync(path)
        // Mask 0o7777 keeps the standard rwx triplet *and* the
        // setuid/setgid/sticky bits. Plain 0o777 would strip them
        // and silently change the security semantics of any file
        // the operator had explicitly chmodded with those bits.
        preservedMode = st.mode & 0o7777
        // Record uid/gid for best-effort post-rename preservation.
        // chown(2) requires CAP_CHOWN unless the new owner is the
        // current process — which is the common case here, so
        // failures are non-fatal and silently swallowed below.
        preservedUid = st.uid
        preservedGid = st.gid
      } catch {
        preservedMode = null
      }
    }
    const openMode = explicitMode ?? preservedMode ?? 0o600
    const enforcedMode = explicitMode ?? preservedMode

    let fd: number | undefined
    try {
      // O_WRONLY | O_CREAT | O_EXCL: refuse to clobber a stale temp
      // file (whose presence would mean another writer just lost the
      // race or crashed mid-write — we cannot safely reuse it).
      fd = fsOpenSync(tempPath, 'wx', openMode)
      // `fchmod(2)` sets the mode bits verbatim, bypassing umask. We
      // only call it for explicit / preserved modes (see resolution
      // branches above); for genuinely new files the umask filter on
      // open is intentional and we leave it alone.
      if (enforcedMode !== null) {
        fsFchmodSync(fd, enforcedMode)
      }
      // Best-effort owner/group preservation when rewriting an
      // existing file. chown(2) succeeds without privileges only
      // when the target uid/gid match the calling process — which
      // is the typical case for KB JSON stores (KB created the file
      // and is rewriting it). Any failure here is swallowed; the
      // intent is "don't silently change owner if we can avoid it",
      // not "guarantee owner preservation across privilege barriers".
      if (preservedUid !== null && preservedGid !== null) {
        try {
          fsFchownSync(fd, preservedUid, preservedGid)
        } catch {
          // Likely EPERM (different owner, no CAP_CHOWN). The new
          // file inherits the caller's effective uid/gid, which is
          // already the standard behaviour for any new file in this
          // tree.
        }
      }
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

  lstatSync(path: string): FileLstat {
    const s = fsLstatSync(path)
    return {
      size: s.size,
      mtime: s.mtime,
      mtimeMs: s.mtimeMs,
      // Capture the booleans verbatim — Node's Stats.isFile() /
      // isSymbolicLink() are mutually exclusive on lstat (a symlink
      // is never reported as a regular file).
      isSymbolicLink: s.isSymbolicLink(),
      isFile: s.isFile(),
    }
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

  realpathSync(path: string): string {
    // `fs.realpathSync` returns a string when no `encoding` option is
    // passed. The Node typings widen the signature to allow `Buffer`
    // for the `'buffer'` encoding overload, so we narrow back here.
    return fsRealpathSync(path) as string
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
