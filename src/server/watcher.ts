import { basename, dirname, join } from 'path'
import { parseLine } from './parser'
import { loadSessionAgentRecords, buildSessionAgentMap } from './agent-reader'
import { resolveProjectRoot } from './config'
import type { FileAccessLayer, WatchEvent, WatchHandle } from './fs-layer'
import type { SessionManager } from './session-manager'
import type { ViewerConfig } from './types'

/**
 * プロジェクトルートパスを Claude のプロジェクトディレクトリ名に変換する
 * 例: "/home/user/my-project" → "-home-user-my-project"
 */
function projectPathToClaudeDirName(projectRoot: string): string {
  return projectRoot.replace(/\//g, '-')
}

export class Watcher {
  private watchHandle: WatchHandle | null = null
  // ファイルごとの読み取り済みバイト位置
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
    // 現在のプロジェクトに対応する Claude のセッションディレクトリのみ監視
    const projectRoot = resolveProjectRoot(this.fs)
    const claudeDirName = projectPathToClaudeDirName(projectRoot)
    const projectSessionsDir = join(this.claudeDir, 'projects', claudeDirName)

    const usePolling = this.config.usePolling
    const pollInterval = this.config.pollInterval

    console.log(`[Watcher] プロジェクトルート: ${projectRoot}`)
    console.log(`[Watcher] 監視開始: ${projectSessionsDir}`)
    console.log(`[Watcher] モード: ${usePolling ? `ポーリング (${pollInterval}ms)` : 'inotify (ネイティブ)'}`)

    // ディレクトリが存在しない場合（まだセッションがない）は作成を待つ
    if (!this.fs.existsSync(projectSessionsDir)) {
      console.log(`[Watcher] セッションディレクトリが未作成です。親ディレクトリを監視して待機します。`)
      const projectsDir = join(this.claudeDir, 'projects')
      // 親ディレクトリを監視し、対象ディレクトリが現れたら切り替える
      this.watchHandle = this.fs.watch(
        projectsDir,
        (event: WatchEvent) => {
          if (event.type === 'addDir') {
            if (basename(event.path) === claudeDirName) {
              console.log(`[Watcher] セッションディレクトリ検出: ${event.path}`)
              this.watchHandle?.close()
              this.watchHandle = null
              this.startWatching(projectSessionsDir, usePolling, pollInterval)
            }
          } else if (event.type === 'ready') {
            // ディレクトリが ready 時点で存在するか再確認
            if (this.fs.existsSync(projectSessionsDir)) {
              this.watchHandle?.close()
              this.watchHandle = null
              this.startWatching(projectSessionsDir, usePolling, pollInterval)
            } else {
              console.log('[Watcher] 初期スキャン完了（セッションなし）')
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
          console.log('[Watcher] 初期スキャン完了')
          this.applyFallbackAgentMapping()
          this.sessionManager.setInitialized()
        } else if (event.type === 'error') {
          console.error('[Watcher] エラー:', event.error)
          // inotify エラー時はポーリングへフォールバック
          if (!usePolling) {
            console.log('[Watcher] inotify エラーのためポーリングにフォールバックします')
            this.watchHandle?.close()
            this.watchHandle = this.fs.watch(
              watchDir,
              (ev: WatchEvent) => {
                if (ev.type === 'add' || ev.type === 'change') {
                  if (ev.path.endsWith('.jsonl')) this.handleFile(ev.path)
                } else if (ev.type === 'error') {
                  console.error('[Watcher] フォールバックエラー:', ev.error)
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
   * `.kovitoboard/session-agents.jsonl` の紐づけ情報を、
   * agent-setting イベントがなかったセッションにフォールバック適用する
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
      console.log(`[Watcher] フォールバック紐づけ適用: ${applied} セッション`)
    }
  }

  private handleFile(filePath: string): void {
    try {
      const stat = this.fs.statSync(filePath)
      const currentSize = stat.size
      const previousPosition = this.filePositions.get(filePath) || 0

      if (currentSize <= previousPosition) return

      // セッションID: ファイル名（拡張子なし）
      const sessionId = basename(filePath, '.jsonl')
      // プロジェクトパス: 親ディレクトリ名
      const projectPath = basename(dirname(filePath))

      // subagents ディレクトリ内のファイルはスキップ（今後対応）
      if (filePath.includes('/subagents/')) return

      this.sessionManager.ensureSession(sessionId, projectPath, filePath)

      // 差分読み取り（fs-layer 経由）
      const buffer = this.fs.readBytesSync(
        filePath,
        previousPosition,
        currentSize - previousPosition
      )

      const newContent = buffer.toString('utf-8')
      const lines = newContent.split('\n').filter((l: string) => l.trim())

      for (const line of lines) {
        // agent-setting イベントからエージェントIDを抽出
        try {
          const raw = JSON.parse(line)
          if (raw.type === 'agent-setting' && raw.agentSetting) {
            this.sessionManager.setAgentId(sessionId, raw.agentSetting)
          }
        } catch { /* パース失敗は無視 */ }

        const events = parseLine(line, sessionId)
        if (events.length > 0) {
          this.sessionManager.addEvents(sessionId, events)
        }
      }

      this.filePositions.set(filePath, currentSize)
    } catch (err) {
      console.error(`[Watcher] ファイル処理エラー: ${filePath}`, err)
    }
  }
}
