import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { resolveProjectRoot } from './config'

interface ManagedProcess {
  id: string
  process: ChildProcess
  sessionId: string | null
  agentId?: string
  status: 'starting' | 'running' | 'completed' | 'error'
  startedAt: string
  stdout: string
  stderr: string
}

/**
 * Claude CLI プロセスの起動・管理を担当
 *
 * - 既存セッションへのメッセージ送信: claude --print --resume <sessionId> "<message>"
 * - 新規セッション開始: claude --print [--agent <agentId>] "<message>"
 *
 * --print モードは1ターンで完了するため、メッセージ送信ごとに新しいプロセスを起動する。
 * JSOBNLファイルへの書き出しは Claude CLI が行い、既存の watcher が検知してUIに反映する。
 */
export class ClaudeBridge extends EventEmitter {
  private processes = new Map<string, ManagedProcess>()
  private defaultCwd: string

  constructor(defaultCwd?: string) {
    super()
    // デフォルトはプロジェクトルート（process.cwd() はサーバー起動ディレクトリになるため使わない）
    this.defaultCwd = defaultCwd || resolveProjectRoot()
  }

  /**
   * 既存セッションにメッセージを送信
   * @param cwd セッションが作成されたプロジェクトのパス（--resume がcwdからプロジェクトを特定するため必須）
   */
  sendToSession(sessionId: string, message: string, cwd?: string): string {
    const args = [
      '--print',
      '--resume', sessionId,
      message
    ]

    return this.spawnClaude(args, cwd || this.defaultCwd, sessionId)
  }

  /**
   * 新規セッションを開始
   */
  startNewSession(message: string, agentId?: string, cwd?: string): string {
    const args = ['--print']

    if (agentId) {
      args.push('--agent', agentId)
    }

    args.push(message)

    return this.spawnClaude(args, cwd || this.defaultCwd, null, agentId)
  }

  /**
   * プロセスの状態を取得
   */
  getProcess(processId: string): ManagedProcess | undefined {
    return this.processes.get(processId)
  }

  /**
   * アクティブなプロセス数
   */
  getActiveCount(): number {
    let count = 0
    for (const p of this.processes.values()) {
      if (p.status === 'starting' || p.status === 'running') count++
    }
    return count
  }

  /**
   * Claude CLI をspawnする共通処理
   */
  private spawnClaude(
    args: string[],
    cwd: string,
    sessionId: string | null,
    agentId?: string
  ): string {
    const processId = randomUUID()

    // メッセージ本文（最後の引数）はログに出さない
    const safeArgs = args.slice(0, -1).join(' ')
    console.log(`[claude-bridge] 起動: claude ${safeArgs} <message:${args[args.length - 1].length}chars>`)
    console.log(`[claude-bridge] cwd: ${cwd}`)

    // Claude Code 関連の環境変数を除去してネスト検知を回避
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC')) {
        delete env[key]
      }
    }

    const child = spawn('claude', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const managed: ManagedProcess = {
      id: processId,
      process: child,
      sessionId,
      agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
    }

    this.processes.set(processId, managed)

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      managed.stdout += text
      this.emit('output', processId, text)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      managed.stderr += text
      // stderr はデバッグ情報として出力
      console.log(`[claude-bridge] stderr(${processId.slice(0, 8)}): ${text.trim()}`)
    })

    child.on('close', (code) => {
      if (code === 0) {
        managed.status = 'completed'
        console.log(`[claude-bridge] 完了(${processId.slice(0, 8)}): exit ${code}`)
      } else {
        managed.status = 'error'
        managed.stdout += managed.stderr
        console.error(`[claude-bridge] エラー(${processId.slice(0, 8)}): exit ${code}`)
      }
      this.emit('process_end', processId, managed.status, code)

      // 完了したプロセスは10分後にクリーンアップ
      setTimeout(() => {
        this.processes.delete(processId)
      }, 10 * 60 * 1000)
    })

    child.on('error', (err) => {
      managed.status = 'error'
      console.error(`[claude-bridge] プロセスエラー(${processId.slice(0, 8)}):`, err.message)
      this.emit('process_end', processId, 'error', -1)
    })

    return processId
  }
}
