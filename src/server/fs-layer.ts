/**
 * ファイルアクセス抽象化レイヤ
 *
 * KovitoBoard は将来の Claude Code Plugin 対応（v0.2.0 以降）で
 * MCP 経由のファイルアクセスを必要とする可能性がある。そのため、
 * コア機能から fs 直接呼び出しを全て排除し、本レイヤ経由に集約する。
 *
 * v0.1.0 では DirectFsLayer（Node.js fs / chokidar を直接使うデフォルト実装）のみ提供する。
 * v0.1.0 内では Sync API のみ提供する（既存コードが全て Sync で書かれているため）。
 * Promise 版 API は Plugin 対応が必要になる v0.2.0 以降で追加する方針。
 *
 * 詳細な設計根拠は kovitoboard-dev の docs/design/v0.1.0-fs-layer-notes.md を参照。
 */

import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
  mkdirSync as fsMkdirSync,
  unlinkSync as fsUnlinkSync,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
} from 'fs'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'

// --- 型定義 ---

/** stat 情報の抽象化（Node.js fs.Stats から必要最小限のフィールドのみ抽出） */
export interface FileStat {
  size: number
  mtime: Date
  mtimeMs: number
}

/** watch イベントの抽象化（chokidar のサブセット） */
export type WatchEvent =
  | { type: 'add'; path: string }
  | { type: 'change'; path: string }
  | { type: 'addDir'; path: string }
  | { type: 'unlink'; path: string }
  | { type: 'ready' }
  | { type: 'error'; error: unknown }

/** watch ハンドル（close のみ提供） */
export interface WatchHandle {
  close(): void
}

/** watch オプション（chokidar のサブセット） */
export interface WatchOptions {
  usePolling?: boolean
  pollInterval?: number
  ignoreInitial?: boolean
  depth?: number
}

// --- FileAccessLayer インターフェース ---

/**
 * ファイルアクセス抽象化レイヤ
 *
 * v0.1.0 では Sync API のみ提供する。
 * 既存コードが全て Sync で書かれているため、挙動変更を避けるための判断。
 * Promise 版 API は v0.2.0 以降で必要になった時点で追加する。
 */
export interface FileAccessLayer {
  // --- 読み取り ---
  readFileSync(path: string, encoding?: BufferEncoding): string
  /** 低レベル差分読み取り（watcher.ts の JSONL 差分パース用） */
  readBytesSync(path: string, offset: number, length: number): Buffer

  // --- 書き込み ---
  writeFileSync(path: string, content: string | Buffer, encoding?: BufferEncoding): void
  unlinkSync(path: string): void

  // --- メタデータ ---
  existsSync(path: string): boolean
  statSync(path: string): FileStat
  readdirSync(path: string): string[]
  mkdirSync(path: string, options?: { recursive?: boolean }): void

  // --- 監視 ---
  watch(
    path: string,
    handler: (event: WatchEvent) => void,
    options?: WatchOptions
  ): WatchHandle
}

// --- DirectFsLayer 実装 ---

/**
 * Node.js 標準 fs / chokidar を直接呼び出すデフォルト実装。
 * v0.1.0 ではこれだけを使用する。
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
