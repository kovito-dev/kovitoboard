/**
 * data-file-watcher.ts — データファイルの外部変更検知ユーティリティ
 *
 * エージェントが直接 JSON ファイルを書き換えた場合に、
 * サーバー再起動なしでインメモリ状態を自動更新するための汎用監視機構。
 *
 * === 新しいデータ Manager を追加する開発者へ ===
 *
 * JSON ファイルで状態を管理する Manager を新設する場合、
 * このクラスを使ってファイル監視を必ず組み込んでください。
 *
 * 手順:
 *   1. Manager のコンストラクタで DataFileWatcher.register() を呼ぶ
 *   2. save() の前後で notifySelfWrite() を呼ぶ
 *   3. コールバックで load() + イベント発火を行う
 *
 * 例:
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
  /** 外部変更時に呼ばれるコールバック */
  onReload: () => void
  /** 自己書き込みの直後か（true なら次の change イベントを無視） */
  selfWritePending: boolean
  /** デバウンスタイマー */
  debounceTimer: ReturnType<typeof setTimeout> | null
}

/** デバウンス間隔（ms）: エージェントの連続書き込みをまとめる */
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
   * 監視対象ファイルを登録する
   *
   * @param filePath 監視するファイルの絶対パス
   * @param onReload 外部変更検知時に呼ばれるコールバック
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
          console.error(`[DataFileWatcher] 監視エラー: ${filePath}`, event.error)
        }
      },
      {
        usePolling: this.usePolling,
        pollInterval: this.pollInterval,
        ignoreInitial: true,
      }
    )

    this.watchHandles.push(handle)
    console.log(`[DataFileWatcher] 登録: ${filePath}`)
  }

  /**
   * 自己書き込みを通知する
   * save() の直前に呼ぶことで、直後の change イベントを無視する
   */
  notifySelfWrite(filePath: string): void {
    const entry = this.entries.get(filePath)
    if (entry) {
      entry.selfWritePending = true
    }
  }

  /** 全監視を停止 */
  close(): void {
    for (const h of this.watchHandles) {
      h.close()
    }
    this.watchHandles = []
    // デバウンスタイマーをクリア
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

    // 自己書き込みの場合はスキップ
    if (entry.selfWritePending) {
      entry.selfWritePending = false
      return
    }

    // デバウンス: 連続変更をまとめる
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      console.log(`[DataFileWatcher] 外部変更検知: ${filePath}`)
      try {
        entry.onReload()
      } catch (err) {
        console.error(`[DataFileWatcher] リロードエラー: ${filePath}`, err)
      }
    }, DEBOUNCE_MS)
  }
}
