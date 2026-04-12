import { execFileSync } from 'child_process'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { resolveProjectRoot } from './config'
import type { FileAccessLayer } from './fs-layer'

/**
 * tmux ウィンドウ名 / エージェントID として有効な文字列かを検証する。
 * 許可: 英数字、ハイフン、アンダースコア（1〜64文字）
 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function isValidTmuxName(name: string): boolean {
  return VALID_NAME_PATTERN.test(name)
}

/**
 * tmux セッション名をプロジェクト名から導出する。
 * 例: projects/my-team → "kovitoboard-my-team"
 * tmux セッション名に使えない文字（ドット、コロン）はハイフンに置換する。
 */
function resolveTmuxSessionName(fs: FileAccessLayer): string {
  const projectDir = basename(resolveProjectRoot(fs))
  const sanitized = projectDir.replace(/[.:]/g, '-')
  return `kovitoboard-${sanitized}`
}

export interface TmuxWindow {
  /** ウィンドウインデックス */
  index: number
  /** ウィンドウ名（= エージェントID） */
  name: string
  /** アクティブかどうか */
  active: boolean
}

export interface TmuxSendResult {
  success: boolean
  error?: string
}

/**
 * tmux 経由で Claude CLI エージェントにメッセージを送信する
 *
 * 前提:
 * - tmux セッション "kovitoboard-{project}" が存在する
 * - 各ウィンドウにエージェントが起動済み（ウィンドウ名 = エージェントID）
 *
 * 送信方式:
 * - 短いメッセージ: tmux send-keys で直接送信
 * - 長文/特殊文字含む: tmpファイル → load-buffer → paste-buffer で安全に送信
 */
export class TmuxBridge {
  private fs: FileAccessLayer
  private _sessionName: string | null = null

  constructor(fs: FileAccessLayer) {
    this.fs = fs
  }

  /**
   * tmux セッション名（プロジェクト名ベース、lazy 評価）
   *
   * 初回アクセス時に resolveProjectRoot(fs) から導出する。
   * モジュールロード時に即時評価しないのは、fs 依存の順序問題を避けるため。
   */
  get sessionName(): string {
    if (!this._sessionName) {
      this._sessionName = resolveTmuxSessionName(this.fs)
    }
    return this._sessionName
  }

  /**
   * エージェントID → tmux ウィンドウ名の変換
   * KovitoBoard: エージェントIDをそのままウィンドウ名として返す
   */
  resolveWindowName(agentId: string): string {
    return agentId
  }

  /**
   * マッピングテーブルを取得
   * 実際のウィンドウ一覧からマッピングを動的構築
   */
  getAgentWindowMap(): Record<string, string> {
    const windows = this.listWindows()
    const map: Record<string, string> = {}
    for (const w of windows) {
      if (w.name !== 'main') {
        // ウィンドウ名 = エージェントID = マッピング先
        map[w.name] = w.name
      }
    }
    return map
  }

  /**
   * tmux の KovitoBoard セッションが存在するか
   * stdio: 'pipe' を明示してstderrがコンソールに漏れるのを防ぐ
   */
  hasSession(): boolean {
    try {
      execFileSync('tmux', ['has-session', '-t', this.sessionName], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  /**
   * KovitoBoard セッションのウィンドウ一覧を取得
   */
  listWindows(): TmuxWindow[] {
    try {
      const output = execFileSync('tmux', [
        'list-windows', '-t', this.sessionName,
        '-F', '#{window_index}|#{window_name}|#{window_active}',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

      if (!output) return []

      return output.split('\n').map((line) => {
        const [index, name, active] = line.split('|')
        return {
          index: Number(index),
          name,
          active: active === '1',
        }
      })
    } catch {
      return []
    }
  }

  /**
   * 指定ウィンドウ（エージェント）にメッセージを送信
   *
   * @param windowName ウィンドウ名（エージェントID）
   * @param message 送信するメッセージ
   */
  sendMessage(windowName: string, message: string): TmuxSendResult {
    if (!isValidTmuxName(windowName)) {
      return { success: false, error: `無効なウィンドウ名: "${windowName}"` }
    }

    // KovitoBoard セッションの存在確認
    if (!this.hasSession()) {
      return { success: false, error: `tmux セッション "${this.sessionName}" が存在しません` }
    }

    // ウィンドウの存在確認
    const windows = this.listWindows()
    const target = windows.find((w) => w.name === windowName)
    if (!target) {
      return {
        success: false,
        error: `ウィンドウ "${windowName}" が見つかりません。存在するウィンドウ: ${windows.map((w) => w.name).join(', ') || '(なし)'}`,
      }
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      this.sendViaBuffer(tmuxTarget, message)

      console.log(`[tmux-bridge] 送信完了: ${tmuxTarget} (${message.length}文字)`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] 送信エラー: ${tmuxTarget}`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 既存セッションをクリアしてから新規メッセージを送信
   */
  async clearAndSendMessage(windowName: string, message: string): Promise<TmuxSendResult> {
    if (!isValidTmuxName(windowName)) {
      return { success: false, error: `無効なウィンドウ名: "${windowName}"` }
    }

    if (!this.hasSession()) {
      return { success: false, error: `tmux セッション "${this.sessionName}" が存在しません` }
    }

    const windows = this.listWindows()
    const target = windows.find((w) => w.name === windowName)
    if (!target) {
      return {
        success: false,
        error: `ウィンドウ "${windowName}" が見つかりません。存在するウィンドウ: ${windows.map((w) => w.name).join(', ') || '(なし)'}`,
      }
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      execFileSync('tmux', ['send-keys', '-t', tmuxTarget, '/clear', 'Enter'], { stdio: 'pipe' })
      console.log(`[tmux-bridge] /clear 送信: ${tmuxTarget}`)

      const ready = await this.waitForPrompt(tmuxTarget, 15000)
      if (!ready) {
        console.warn(`[tmux-bridge] プロンプト検出タイムアウト: ${tmuxTarget}（フォールバックで送信続行）`)
      }

      this.sendViaBuffer(tmuxTarget, message)

      console.log(`[tmux-bridge] clear+送信完了: ${tmuxTarget} (${message.length}文字)`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] clear+送信エラー: ${tmuxTarget}`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * プロンプトの出現を待機
   */
  private async waitForPrompt(tmuxTarget: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now()
    const pollInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const output = execFileSync('tmux', [
          'capture-pane', '-t', tmuxTarget, '-p', '-S', '-5',
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
        const lines = output.split('\n').filter((l) => l.trim())
        const lastLines = lines.slice(-3).join(' ')
        if (lastLines.includes('❯') && lastLines.includes('⏵')) {
          console.log(`[tmux-bridge] プロンプト検出: ${tmuxTarget} (${Date.now() - startTime}ms)`)
          return true
        }
      } catch {
        // capture-pane 失敗は無視して続行
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    return false
  }

  /**
   * load-buffer → paste-buffer → Enter で安全にメッセージを送信
   */
  private sendViaBuffer(tmuxTarget: string, message: string): void {
    const tmpFile = join(tmpdir(), `kovitoboard-tmux-${randomUUID()}.txt`)

    try {
      const sanitized = message
        .replace(/\r\n/g, '\\n')
        .replace(/[\r\n]/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim()

      if (!sanitized) {
        throw new Error('サニタイズ後のメッセージが空です')
      }

      console.log(`[tmux-bridge] 送信準備: ${sanitized.length}文字`)

      this.fs.writeFileSync(tmpFile, sanitized, 'utf-8')

      execFileSync('tmux', [
        'load-buffer', tmpFile,
        ';', 'paste-buffer', '-r', '-t', tmuxTarget,
        ';', 'send-keys', '-t', tmuxTarget, 'Enter',
      ], { stdio: 'pipe' })
    } finally {
      try { this.fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  }

  /**
   * KovitoBoard セッションを作成（存在しない場合）
   */
  ensureSession(): void {
    if (this.hasSession()) return

    const projectRoot = resolveProjectRoot(this.fs)
    execFileSync('tmux', [
      'new-session', '-d', '-s', this.sessionName, '-n', 'main', '-c', projectRoot,
    ], { stdio: 'pipe' })
    console.log(`[tmux-bridge] セッション "${this.sessionName}" を作成しました (cwd: ${projectRoot})`)
  }

  /**
   * エージェントを新しいウィンドウで起動
   *
   * Phase 5 以降: 起動時の信頼確認プロンプト自動承認は撤去済み（仕様書 §3-3 / §5-3-3）。
   * 初回フォルダ信頼プロンプトが表示された場合は、検知ループ (trust-prompt-detector) が
   * 拾って UI に中継する。
   */
  async startAgent(agentId: string, windowName?: string, cwd?: string): Promise<TmuxSendResult> {
    if (!isValidTmuxName(agentId)) {
      return { success: false, error: `無効なエージェントID: "${agentId}"` }
    }
    const name = windowName || agentId
    if (windowName && !isValidTmuxName(windowName)) {
      return { success: false, error: `無効なウィンドウ名: "${windowName}"` }
    }
    const workDir = cwd || resolveProjectRoot(this.fs)

    const windows = this.listWindows()
    if (windows.find((w) => w.name === name)) {
      return { success: false, error: `ウィンドウ "${name}" は既に存在します` }
    }

    this.ensureSession()

    try {
      execFileSync('tmux', [
        'new-window', '-t', this.sessionName, '-n', name, '-c', workDir,
        'claude', '--agent', agentId,
      ], { stdio: 'pipe' })
      console.log(`[tmux-bridge] エージェント起動: ${name} (${agentId}) in ${workDir}`)

      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] エージェント起動エラー:`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * ウィンドウの現在のペイン内容を取得
   *
   * Phase 5 の検知ループから呼ばれる（capture-pane -p -S -<lines> -E -）。
   * デバッグ用にも使える。
   */
  capturePane(windowName: string, lines?: number): string | null {
    if (!isValidTmuxName(windowName)) return null
    try {
      const lineCount = lines || 50
      const output = execFileSync('tmux', [
        'capture-pane', '-t', `${this.sessionName}:${windowName}`, '-p', '-S', `-${lineCount}`,
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      return output
    } catch {
      return null
    }
  }

  /**
   * trust-prompt-detector からユーザー応答を受け取って tmux に send-keys する
   *
   * @param windowName 対象ウィンドウ名
   * @param keys 送信するキー列（末尾 `\n` は `Enter` キーに変換する）
   * @param literal `true` の場合 `send-keys -l`（literal モード）で送信する（fallback UX 用）
   * @returns 送信成功可否
   */
  sendTrustPromptKeys(windowName: string, keys: string, literal = false): boolean {
    if (!isValidTmuxName(windowName)) {
      console.warn(`[tmux-bridge] 無効なウィンドウ名: "${windowName}"`)
      return false
    }
    if (!this.hasSession()) {
      console.warn(`[tmux-bridge] tmux セッション "${this.sessionName}" が存在しません`)
      return false
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      const args = ['send-keys', '-t', tmuxTarget]
      if (literal) {
        args.push('-l', '--', keys)
      } else {
        // 末尾 `\n` は Enter キーに変換
        const parts = parseKeysForSendKeys(keys)
        args.push('--', ...parts)
      }
      execFileSync('tmux', args, { stdio: 'pipe' })
      console.log(`[tmux-bridge] trust-prompt 応答送信: ${tmuxTarget} keys=${JSON.stringify(keys)} literal=${literal}`)
      return true
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] trust-prompt 応答送信エラー: ${tmuxTarget}`, errorMsg)
      return false
    }
  }
}

/**
 * `"1\n"` → `["1", "Enter"]` / `"Enter"` → `["Enter"]` の変換
 *
 * tmux `send-keys` はキー名（`Enter`, `Escape` 等）と通常文字を複数引数で
 * 受け取る。仕様書 §5-1 の `choices[].keys` は `"2\n"` 形式だが、
 * 生 `\n` を送るとエスケープ解釈が面倒なため、末尾 `\n` は `Enter` に変換する。
 */
export function parseKeysForSendKeys(keys: string): string[] {
  if (keys.length === 0) return []
  if (keys.endsWith('\n')) {
    const prefix = keys.slice(0, -1)
    return prefix ? [prefix, 'Enter'] : ['Enter']
  }
  return [keys]
}
