/**
 * Fake Claude Harness — Playwright E2E テスト用 tmux モック管理
 *
 * Fake Claude スクリプトを tmux セッション内で起動し、
 * KB の trust-prompt-detector が本番同様にキャプチャ → 検知できる環境を作る。
 *
 * @see docs/design/fake-claude-design.md
 * @see docs/design/decisions/DEC-010-fake-claude-e2e-strategy.md
 */

import { execSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Fake Claude スクリプトが配置されているディレクトリ */
const FAKE_CLAUDE_DIR = resolve(__dirname, '../../fixtures/fake-claude')

export type FakeClaudeScenario =
  | 'folder-trust'
  | 'write-create'
  | 'edit-modify'
  | 'bash-simple'
  | 'rejection-flow'

export interface FakeClaudeHandle {
  /** tmux セッション名（unique） */
  sessionName: string
  /** tmux window 名 */
  windowName: string
  /** セッションを破棄 */
  dispose(): Promise<void>
  /** 追加で send-keys を送信（応答後の続き操作用） */
  sendKeys(keys: string): Promise<void>
  /** 現在のパネル内容を取得（デバッグ・assert 用） */
  capture(): Promise<string>
}

export interface StartFakeClaudeOptions {
  /** シナリオ名（scenarios/*.sh のファイル名から .sh を除いたもの） */
  scenario: FakeClaudeScenario
  /** tmux window 名（KB は window 名をエージェント ID として扱う） */
  windowName: string
  /** tmux セッション名を明示指定（デフォルト: E2E 共有セッション名を自動解決） */
  sessionName?: string
}

/**
 * E2E 共有 tmux セッション名を取得する。
 *
 * KOVITOBOARD_E2E_TMUX_SESSION 環境変数が設定されていればそれを使う。
 * 未設定時はテスト固有の一意名を生成する。
 */
function resolveSessionName(override?: string): string {
  if (override) return override
  return process.env.KOVITOBOARD_E2E_TMUX_SESSION || `kb-e2e-${randomUUID().slice(0, 8)}`
}

/**
 * Fake Claude を tmux セッション内で起動する。
 *
 * KB の tmux-bridge が KOVITOBOARD_E2E_TMUX_SESSION で指定されたセッションを
 * 参照するため、そのセッション内に window を作成する。
 */
export async function startFakeClaude(
  opts: StartFakeClaudeOptions,
): Promise<FakeClaudeHandle> {
  const sessionName = resolveSessionName(opts.sessionName)
  const scriptPath = resolve(FAKE_CLAUDE_DIR, 'entrypoint.sh')

  // セッションが存在しなければ作成
  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: 'pipe',
  })

  if (hasSession.status !== 0) {
    // 新規セッション作成（画面サイズ固定: 落とし穴 #2 対策）
    execSync(
      `tmux new-session -d -s "${sessionName}" -n main -x 200 -y 50`,
      { stdio: 'pipe' },
    )
  }

  // 同名 window が既にあれば削除（冪等性）
  spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${opts.windowName}`], {
    stdio: 'pipe',
  })

  // Fake Claude スクリプトを起動する window を作成
  execSync(
    `tmux new-window -t "${sessionName}" -n "${opts.windowName}" ` +
    `"bash '${scriptPath}' '${opts.scenario}'"`,
    { stdio: 'pipe' },
  )

  // fixture のレンダリングが完了するまで少し待つ
  await new Promise((r) => setTimeout(r, 500))

  return {
    sessionName,
    windowName: opts.windowName,

    async dispose() {
      spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${opts.windowName}`], {
        stdio: 'pipe',
      })
      // セッション内に window が残っていなければセッションも破棄
      const remaining = spawnSync('tmux', [
        'list-windows', '-t', sessionName,
      ], { stdio: 'pipe' })
      const output = remaining.stdout?.toString().trim() ?? ''
      // main window だけ or 空ならセッション破棄
      const lines = output.split('\n').filter((l) => l.trim())
      if (lines.length <= 1) {
        spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' })
      }
    },

    async sendKeys(keys: string) {
      spawnSync('tmux', [
        'send-keys', '-t', `${sessionName}:${opts.windowName}`, keys,
      ], { stdio: 'pipe' })
    },

    async capture() {
      const r = spawnSync('tmux', [
        'capture-pane', '-pt', `${sessionName}:${opts.windowName}`, '-S', '-200',
      ], { stdio: 'pipe' })
      return r.stdout?.toString() ?? ''
    },
  }
}

/**
 * E2E テスト用の tmux セッションを完全にクリーンアップする。
 * test.afterAll で呼ぶ。
 */
export async function cleanupFakeClaudeSession(sessionName: string): Promise<void> {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' })
}
