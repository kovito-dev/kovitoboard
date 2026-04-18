import { EventEmitter } from 'events'
import type { Session, SessionSummary, SessionStats, ParsedEvent } from './types'

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private statusTimers = new Map<string, NodeJS.Timeout>()
  // Initializing flag: while true, skip status updates (keep existing sessions as idle)
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
      // Project name: restore directory name from path hash
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
      // new_session event fires on first message addition (to exclude empty sessions from the list)
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
   * Set all active sessions for the specified agent to idle.
   * Used to terminate existing sessions when a new session starts.
   */
  deactivateAgentSessions(agentId: string): string[] {
    const deactivated: string[] = []
    for (const [id, session] of this.sessions) {
      if (session.agentId === agentId && session.status !== 'idle') {
        session.status = 'idle'
        // Clear idle timer as well (no longer needed since already idle)
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
   * Notify that initial loading is complete.
   * Called after the Watcher's ready event.
   */
  setInitialized(): void {
    this.initializing = false
    console.log(`[SessionManager] Initialization complete: ${this.sessions.size} sessions loaded`)
  }

  /** Returns a map of session ID to agent ID */
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

    // Determine whether to fire new_session on first message addition
    const wasEmpty = session.stats.userMessages === 0 && session.stats.assistantMessages === 0

    for (const event of events) {
      session.events.push(event)
      session.lastEventAt = event.timestamp

      // Update stats
      this.updateStats(session.stats, event)

      // Update status
      this.updateStatus(session, event)

      this.emit('new_event', sessionId, event)
    }

    // First message added to a previously empty session → notify new_session
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
    // Skip status updates during initial loading (existing sessions remain idle)
    if (this.initializing) return

    const oldStatus = session.status

    if (event.type === 'user') {
      session.status = 'waiting'
    } else if (event.type === 'assistant' || event.type === 'tool_use') {
      // stop_reason is end_turn → response complete, awaiting next input (ready)
      // Otherwise → still processing (thinking)
      if (event.metadata.stopReason === 'end_turn') {
        session.status = 'ready'
      } else {
        session.status = 'thinking'
      }
    }

    // Idle timer: transition to idle after 5 minutes of no events
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
    // "-home-user-some-workspace" → "some-workspace"
    const parts = projectPath.replace(/^-/, '').split('-')
    // Extract the last meaningful parts
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
