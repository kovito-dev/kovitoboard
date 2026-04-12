import { EventEmitter } from 'events'
import type { Session, SessionSummary, SessionStats, ParsedEvent } from './types'

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private statusTimers = new Map<string, NodeJS.Timeout>()
  // 初期読み込み中フラグ: true の間はステータス更新をスキップ（既存セッションを idle のまま保つ）
  private initializing = true

  getSessions(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.stats.userMessages > 0 || s.stats.assistantMessages > 0)
      .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())
      .map((s) => this.toSummary(s))
  }

  getSession(id: string): Session | null {
    return this.sessions.get(id) || null
  }

  ensureSession(sessionId: string, projectPath: string, filePath: string): Session {
    let session = this.sessions.get(sessionId)
    if (!session) {
      // プロジェクト名: パスハッシュからディレクトリ名を復元
      const projectName = this.extractProjectName(projectPath)
      const now = new Date().toISOString()
      session = {
        id: sessionId,
        projectPath,
        projectName,
        filePath,
        status: 'idle',
        events: [],
        lastEventAt: now,
        startedAt: now,
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0
        }
      }
      this.sessions.set(sessionId, session)
      // new_session イベントはメッセージ追加時に発火（空セッションをリストに出さないため）
    }
    return session
  }

  setAgentId(sessionId: string, agentId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.agentId = agentId
    }
  }

  /**
   * 指定エージェントのアクティブセッションをすべて idle に変更する
   * 新規セッション開始時に既存セッションを終了させるために使用
   */
  deactivateAgentSessions(agentId: string): string[] {
    const deactivated: string[] = []
    for (const [id, session] of this.sessions) {
      if (session.agentId === agentId && session.status !== 'idle') {
        session.status = 'idle'
        // idle タイマーもクリア（既に idle なので不要）
        const timerId = this.statusTimers.get(id)
        if (timerId) {
          clearTimeout(timerId)
          this.statusTimers.delete(id)
        }
        this.emit('status_change', id, 'idle')
        deactivated.push(id)
      }
    }
    return deactivated
  }

  /**
   * 初期読み込み完了を通知する
   * Watcher の ready イベント後に呼び出す
   */
  setInitialized(): void {
    this.initializing = false
    console.log(`[SessionManager] 初期化完了: ${this.sessions.size} セッション読み込み済み`)
  }

  /** セッションID → エージェントID のマップを返す */
  getSessionAgentMap(): Record<string, string> {
    const map: Record<string, string> = {}
    for (const [id, session] of this.sessions) {
      if (session.agentId) {
        map[id] = session.agentId
      }
    }
    return map
  }

  addEvents(sessionId: string, events: ParsedEvent[]): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // 初回メッセージ追加時に new_session を発火するかどうか判定
    const wasEmpty = session.stats.userMessages === 0 && session.stats.assistantMessages === 0

    for (const event of events) {
      session.events.push(event)
      session.lastEventAt = event.timestamp

      // 統計更新
      this.updateStats(session.stats, event)

      // ステータス更新
      this.updateStatus(session, event)

      this.emit('new_event', sessionId, event)
    }

    // 空だったセッションに初めてメッセージが入った → new_session を通知
    if (wasEmpty && (session.stats.userMessages > 0 || session.stats.assistantMessages > 0)) {
      const summary = this.toSummary(session)
      this.emit('new_session', summary)
    }
  }

  private updateStats(stats: SessionStats, event: ParsedEvent): void {
    switch (event.type) {
      case 'user':
        stats.userMessages++
        break
      case 'assistant':
        stats.assistantMessages++
        break
      case 'tool_use':
        stats.toolCalls++
        break
    }
    if (event.metadata.inputTokens) stats.totalInputTokens += event.metadata.inputTokens
    if (event.metadata.outputTokens) stats.totalOutputTokens += event.metadata.outputTokens
  }

  private updateStatus(session: Session, event: ParsedEvent): void {
    // 初期読み込み中はステータス更新をスキップ（既存セッションは idle のまま）
    if (this.initializing) return

    const oldStatus = session.status

    if (event.type === 'user') {
      session.status = 'waiting'
    } else if (event.type === 'assistant' || event.type === 'tool_use') {
      // stop_reason が end_turn → 応答完了、次の入力待ち（ready）
      // それ以外 → まだ処理中（thinking）
      if (event.metadata.stopReason === 'end_turn') {
        session.status = 'ready'
      } else {
        session.status = 'thinking'
      }
    }

    // idle タイマー: 5分イベントなしで idle に
    const timerId = this.statusTimers.get(session.id)
    if (timerId) clearTimeout(timerId)

    this.statusTimers.set(
      session.id,
      setTimeout(() => {
        if (session.status !== 'idle') {
          session.status = 'idle'
          this.emit('status_change', session.id, 'idle')
        }
      }, 5 * 60 * 1000)
    )

    if (session.status !== oldStatus) {
      this.emit('status_change', session.id, session.status)
    }
  }

  private extractProjectName(projectPath: string): string {
    // "-home-irikura-anode-workspace" → "anode-workspace"
    const parts = projectPath.replace(/^-/, '').split('-')
    // 最後の意味のある部分を取得
    if (parts.length >= 2) {
      return parts.slice(-2).join('-')
    }
    return parts[parts.length - 1] || projectPath
  }

  private toSummary(s: Session): SessionSummary {
    const lastUserEvent = [...s.events].reverse().find((e) => e.type === 'user')
    return {
      id: s.id,
      projectName: s.projectName,
      projectPath: s.projectPath,
      status: s.status,
      agentId: s.agentId,
      lastEventAt: s.lastEventAt,
      startedAt: s.startedAt,
      stats: { ...s.stats },
      lastMessage: lastUserEvent?.content.text?.slice(0, 80)
    }
  }
}
