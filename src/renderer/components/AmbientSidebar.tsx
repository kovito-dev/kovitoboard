/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import { useSidebarSettings } from '../hooks/useSidebarSettings'
import { usePinnedAgent } from '../hooks/usePinnedAgent'
import { useSidebarContext } from '../hooks/useSidebarContext'
import { captureAccessibilitySnapshot, SNAPSHOT_PERF_WARN_MS } from '../lib/accessibility-snapshot'
import { activateElementPicker, describePickedElement } from '../lib/element-picker'
import { getExposedContext } from '../lib/exposeContext'
import { createLogger } from '../lib/logger'
import { wrapWithSentinel } from '../../shared/kb-authored-sentinel'
import type { AgentInfo, Session, SessionSummary, NewSessionResponse, SendMessageResponse, TmuxStatus } from '../types'
import type { AppMenuEntry } from '../types/app-types'
import { AgentAvatar } from './AgentAvatar'
import { MarkdownPreview } from './MarkdownPreview'
import { UserMessageText } from './MessageBubble'
import { FilePreview } from './FilePreview'
import { KbAuthoredSections } from './KbAuthoredSections'
import { MessageInput } from './MessageInput'
import { AppActionsMenuButton } from './AppActionsMenuButton'
import { AppActionsPopover } from './AppActionsPopover'
import { SlashCommandWarningModal } from './SlashCommandWarningModal'
import {
  detectSlashCommand,
  isSlashCommandWarningSuppressed,
  suppressSlashCommandWarning,
} from '../utils/slash-command'
import { isSystemOnlyMessage } from '../utils/system-only-message'
import { parseKbAuthoredSections } from '../utils/kb-authored-message'

const log = createLogger('AmbientSidebar')

/**
 * AmbientSidebar — DEC-020 / EU8.
 *
 * Renders a right-side, collapsible ambient sidebar on supported pages
 * (mounted by App.tsx; suppressed on the Sessions and Agents screens).
 *
 * Phases:
 *   1. (done) Chrome: toggle, drag-resize width, localStorage persist
 *   2. Agent picker + per-app pinning + message I/O
 *      2-A (done) BE: setting schema, session origin, reservation queue
 *      2-B (this commit) FE hooks + agent picker + pin button
 *      2-C messaging surface + Settings tab
 *   3. Screen context injection (kbcontext block)
 *   4. Accessibility tree snapshot
 *   5. User selection (alpha) + window.kb.exposeContext (beta)
 *
 * Width:
 *   - Initial 320px (spec §5.2 recommended range 320-400)
 *   - User-resizable via drag handle on the left edge while open
 *   - Persisted to localStorage so the chosen width survives reload
 *   - Collapsed state shrinks to a 40px rail (resize disabled)
 *
 * Initial open state defaults to closed but honors
 * `ambientSidebar.openByDefault` from setting.json once the BE settings
 * have loaded.
 */

const STORAGE_KEY_WIDTH = 'kb.ambientSidebar.width'
const DEFAULT_WIDTH = 320
const MIN_WIDTH = 240
const MAX_WIDTH = 720
const COLLAPSED_WIDTH = 40

function loadStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_WIDTH)
    if (!raw) return DEFAULT_WIDTH
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return DEFAULT_WIDTH
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
  } catch {
    // SSR / privacy mode: localStorage may throw
    return DEFAULT_WIDTH
  }
}

function persistWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_WIDTH, String(Math.round(width)))
  } catch {
    // Ignore persistence failures (privacy mode, quota, etc.)
  }
}

interface AmbientSidebarProps {
  /** All agents available from /api/agents. Required to render the picker
   *  and to fall back when a pinned agent has been deleted (spec §2.5). */
  agents: AgentInfo[]
  /** All known sessions from useIPC; used to discover and follow the
   *  current sidebar-origin session. */
  sessions: SessionSummary[]
  /** Map of sessionId → agentId. Used as a secondary join key for
   *  legacy sessions whose `origin` was not recorded. */
  sessionAgentMap: Record<string, string>
  /** Currently selected session detail (events for the message list). */
  currentSession: Session | null
  /** Make `currentSession` switch to the given id (so the sidebar can
   *  fetch the events for the session it just adopted). */
  selectSession: (id: string) => void
  /** New-session API. The sidebar always passes `origin: 'sidebar'`. */
  startNewSession: (
    message: string,
    agentId?: string,
    options?: { origin?: 'sidebar' | 'sessions' },
  ) => Promise<NewSessionResponse>
  /** Append a message to an existing session. */
  sendMessage: (sessionId: string, message: string) => Promise<SendMessageResponse>
  /** Tmux session/window snapshot. Required to resolve the agent
   *  window for the Stop button (Q6 / SS-5). */
  tmuxStatus: TmuxStatus | null
  /** Q6 / SS-5: dispatch Ctrl-C to a tmux window. */
  tmuxInterrupt: (windowName: string) => Promise<void>
  /**
   * User extension menu entries. Used by useSidebarContext to resolve
   * a friendly screenLabel for `/ext/<id>` routes. Pass an empty array
   * if extensions have not loaded yet — the context falls back to the
   * raw appId in that case.
   */
  userMenuEntries: AppMenuEntry[]
  /**
   * `appId` resolved from the active route by the parent. `null` when
   * the active route is not an `/ext/<appId>` page. The popover
   * spawned by the toolbar `⋯` button and the Export / Remove actions
   * use this value (DEC-024 #5 / spec §F3 / §F7).
   *
   * The internal `appId` state used for sidebar pinning lives in
   * `usePinnedAgent`. Both should resolve to the same value when an
   * app screen is open; the prop is the authoritative source for the
   * popover so the parent can guarantee the actions target what the
   * user is actually looking at.
   */
  currentAppId: string | null
  /** Friendly label for the focused app (from `userMenuEntries`). */
  currentAppDisplayName: string | null
  /** Open the AppRemovalModal for the popover-selected app. */
  onRequestAppRemoval: (target: { appId: string; displayName: string }) => void
  /**
   * Non-destructive disable for a bundled / grandfather sample
   * app from the AmbientSidebar Actions popover. The destructive
   * remove-app flow is now gated on `source` -- bundled / sample
   * apps must take this path so `app/data/<appId>/` is preserved
   * (grandfather data-preservation invariant). The sidebar wires
   * the same callback the Apps tab uses (`App.tsx` implements
   * `POST /api/recipes/sample/:recipeId/disable`).
   */
  onRequestSampleDisable: (target: {
    appId: string
    recipeId: string
    displayName: string
  }) => void
  /** Open the RecipeExportModal for the popover-selected app. */
  onRequestRecipeExport: (target: { appId: string; displayName: string }) => void
  /** UI theme. Forwarded to <AgentAvatar> in the agent picker so the
   *  light-mode avatar variant is picked when active. */
  theme?: 'dark' | 'light'
}

export function AmbientSidebar({
  agents,
  sessions,
  sessionAgentMap,
  currentSession,
  tmuxStatus,
  tmuxInterrupt,
  selectSession,
  startNewSession,
  sendMessage,
  userMenuEntries,
  currentAppId,
  currentAppDisplayName,
  onRequestAppRemoval,
  onRequestSampleDisable,
  onRequestRecipeExport,
  theme = 'dark',
}: AmbientSidebarProps) {
  // Used by the AS-6 / Q8 "open in sessions screen" button to take the
  // user to the dedicated `/sessions/<id>` view for the session that
  // is currently driving the sidebar conversation.
  const navigate = useNavigate()
  // openByDefault from setting.json initializes the open state once
  // BE settings have loaded. We do NOT keep the two in sync afterwards
  // — the user's session-local toggle should win until they explicitly
  // change the default in the Settings UI (Phase 2-C).
  const { settings, loading: settingsLoading, setPin } = useSidebarSettings()
  const { appId, pinnedAgentId, pin } = usePinnedAgent(agents, settings, setPin)

  const [isOpen, setIsOpen] = useState(false)
  const [hasAppliedDefault, setHasAppliedDefault] = useState(false)
  // Per-app action popover toggle (the `⋯` menu in the toggle row).
  // Closed automatically whenever the sidebar collapses or the focused
  // app changes so a stale popover never lingers across navigation.
  const [isAppActionsOpen, setIsAppActionsOpen] = useState(false)
  useEffect(() => {
    if (!isOpen) setIsAppActionsOpen(false)
  }, [isOpen])
  useEffect(() => {
    setIsAppActionsOpen(false)
  }, [currentAppId])
  useEffect(() => {
    if (settingsLoading || hasAppliedDefault) return
    if (settings.openByDefault) setIsOpen(true)
    setHasAppliedDefault(true)
  }, [settingsLoading, hasAppliedDefault, settings.openByDefault])

  // Selected agent: starts at the resolved pin, but the user may
  // override per-session via the picker without persisting.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(pinnedAgentId)
  // Re-sync when the screen (and therefore the pin) changes.
  useEffect(() => {
    setSelectedAgentId(pinnedAgentId)
  }, [pinnedAgentId])

  const [pinning, setPinning] = useState(false)
  const handlePin = useCallback(async () => {
    if (!appId) return
    setPinning(true)
    try {
      await pin(selectedAgentId)
    } finally {
      setPinning(false)
    }
  }, [appId, pin, selectedAgentId])

  const isPinnedToCurrent =
    appId !== null &&
    selectedAgentId !== null &&
    settings.pinned[appId] === selectedAgentId

  // --- Session tracking ---
  // Latest sidebar-origin session for the selected agent. Adopt it so
  // follow-up messages append to the same conversation, and so the
  // simple message list below mirrors the live transcript.
  const sidebarSessionId = useMemo<string | null>(() => {
    if (!selectedAgentId) return null
    const candidate = sessions.find(
      (s) =>
        s.origin === 'sidebar' &&
        sessionAgentMap[s.id] === selectedAgentId,
    )
    return candidate?.id ?? null
  }, [sessions, sessionAgentMap, selectedAgentId])

  // Whenever we observe a new sidebarSessionId, switch the IPC channel
  // over to it so `currentSession` reflects this session's events.
  useEffect(() => {
    if (sidebarSessionId) selectSession(sidebarSessionId)
  }, [sidebarSessionId, selectSession])

  // --- Screen context (Phase 3) ---
  // Resolve the current screen so kbcontext can be prepended to outgoing
  // messages. Snapshot is captured at send time below to keep the
  // serialized URL aligned with what the user sees, even if they
  // navigate during send.
  const sidebarContext = useSidebarContext(userMenuEntries)

  // --- α-method: picked element (Phase 5) ---
  // The picker writes directly into a ref so the active drag does not
  // re-render the sidebar; commit copies the description into state so
  // the UI can show a "selected" pill and let the user clear it.
  const [pickedDescription, setPickedDescription] = useState<string | null>(null)
  const [isPicking, setIsPicking] = useState(false)
  const pickerHandleRef = useRef<{ stop: () => void } | null>(null)

  const stopPicking = useCallback(() => {
    pickerHandleRef.current?.stop()
    pickerHandleRef.current = null
    setIsPicking(false)
  }, [])

  const togglePicking = useCallback(() => {
    if (isPicking) {
      stopPicking()
      return
    }
    setIsPicking(true)
    pickerHandleRef.current = activateElementPicker({
      onPick: (el) => {
        setPickedDescription(describePickedElement(el))
        setIsPicking(false)
        pickerHandleRef.current = null
      },
      onCancel: () => {
        setIsPicking(false)
        pickerHandleRef.current = null
      },
    })
  }, [isPicking, stopPicking])

  // Stop picking when the sidebar closes or the agent is changed
  // mid-pick — the selection becomes meaningless in those contexts.
  useEffect(() => {
    if ((!isOpen || !selectedAgentId) && pickerHandleRef.current) {
      stopPicking()
    }
  }, [isOpen, selectedAgentId, stopPicking])

  // --- Composer ---
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  /**
   * Compose the outgoing payload (DEC-020 §2.3 / Phase 3 + §2.4 / Phase 4):
   *   - First message of a sidebar-origin session prepends a one-shot
   *     `systemPromptPreamble` so the agent learns the kbcontext /
   *     a11y / Selected / ExposedContext conventions.
   *   - Every message prepends the kbcontext block (when an appId is
   *     resolved). The block is omitted for unknown routes rather than
   *     sending a noisy `appId: null` payload.
   *   - Every message also prepends a viewport-scoped a11y snapshot.
   *     Snapshot capture is fail-silent (spec §2.4) — a null result
   *     simply omits the block; the user message still ships.
   *   - Sections are joined with blank lines for readability.
   */
  function composePayload(userText: string, isFirstMessage: boolean): string {
    const parts: string[] = []
    // Each KB-authored sub-block is wrapped in a rule-line sentinel
    // so the renderer's `parseKbAuthoredSections` walks them in
    // O(blocks). The previous dual-write fences (` ```kbcontext `,
    // ` ```a11y `, ` ```Selected `, ` ```ExposedContext `) were
    // dropped in v0.2.0 (K-15, spec
    // `kb-authored-sentinel.md` v1.3 §11.3) — only the sentinel
    // envelope identifies the kind now.
    if (isFirstMessage) {
      parts.push(wrapWithSentinel('preamble', sidebarContext.systemPromptPreamble))
    }
    if (sidebarContext.kbcontextBlock) {
      parts.push(wrapWithSentinel('kbcontext', sidebarContext.kbcontextBlock))
    }

    // a11y snapshot — fail-silent, perf-bounded (spec §2.4).
    // We exclude the sidebar's own DOM by rooting at <main> when one
    // exists; otherwise default to body. Either way the sidebar may
    // still appear when it's inside <main>'s sibling tree, but it
    // never recurses into our own component tree because we capture
    // *before* injecting our messages.
    const snapshot = captureAccessibilitySnapshot()
    if (snapshot) {
      if (snapshot.elapsedMs > SNAPSHOT_PERF_WARN_MS) {
        log.warn(
          { elapsedMs: Math.round(snapshot.elapsedMs), nodeCount: snapshot.nodeCount },
          'a11y snapshot exceeded perf threshold',
        )
      }
      if (snapshot.truncated) {
        log.debug({ nodeCount: snapshot.nodeCount }, 'a11y snapshot truncated at size cap')
      }
      // Skip emission when the walker produced an empty body (only the
      // fence wrapper). Sending an empty fenced block adds noise.
      if (snapshot.nodeCount > 0) {
        parts.push(wrapWithSentinel('a11y', snapshot.block))
      }
    }

    // α-method: picked element (Phase 5 §2.4). When the user has
    // selected an element via the picker, ship its description as a
    // [Selected] block. Selection survives across messages until the
    // user clears it.
    if (pickedDescription) {
      parts.push(wrapWithSentinel('selected', pickedDescription))
    }

    // β-method: app-published context (Phase 5 §2.4). Apps call
    // window.kb.exposeContext({...}) to publish state the DOM does
    // not carry. We ship the serialized payload as the body of an
    // `exposed-context` sentinel; the sentinel header carries the
    // kind identifier so no inner fence is needed (K-15 cutover).
    // Skipped when no app has published yet.
    const exposed = getExposedContext()
    if (exposed) {
      parts.push(wrapWithSentinel('exposed-context', exposed.serialized))
    }

    parts.push(userText)
    return parts.join('\n\n')
  }

  /**
   * Send invoked from <MessageInput>. The argument is the composed
   * message body — including any attachment lines that MessageInput
   * appended for uploaded files / screenshots — so we wrap it in the
   * same kbcontext / a11y / picked-element preamble that the bespoke
   * textarea used to assemble. The local draft is cleared by
   * MessageInput itself once `onSend` resolves.
   */
  const performSend = useCallback(async (text: string) => {
    if (!text || !selectedAgentId) return
    setIsSending(true)
    setSendError(null)
    try {
      if (sidebarSessionId) {
        const payload = composePayload(text, false)
        await sendMessage(sidebarSessionId, payload)
      } else {
        const payload = composePayload(text, true)
        await startNewSession(payload, selectedAgentId, { origin: 'sidebar' })
      }
    } catch (err) {
      log.warn({ err }, 'Failed to send message from sidebar')
      setSendError(err instanceof Error ? err.message : String(err))
      // Re-throw so MessageInput keeps the draft visible for the user
      // to retry — it surfaces its own send-error pill in that path.
      throw err
    } finally {
      setIsSending(false)
    }
  }, [selectedAgentId, sidebarSessionId, sendMessage, startNewSession, sidebarContext, pickedDescription])

  // Pending slash-command awaiting confirmation (Q12 / SS-6). Mirrors
  // the ChatTimeline path so the warning is consistent across surfaces.
  const [pendingSlashMessage, setPendingSlashMessage] = useState<string | null>(null)

  const handleSend = useCallback(async (rawMessage: string) => {
    const text = rawMessage.trim()
    if (!text || !selectedAgentId) return
    if (detectSlashCommand(text) && !isSlashCommandWarningSuppressed()) {
      setPendingSlashMessage(text)
      return
    }
    await performSend(text)
  }, [selectedAgentId, performSend])

  const handleConfirmSlashCommand = useCallback((suppressFuture: boolean) => {
    const message = pendingSlashMessage
    setPendingSlashMessage(null)
    if (!message) return
    if (suppressFuture) suppressSlashCommandWarning()
    void performSend(message)
  }, [pendingSlashMessage, performSend])

  const handleCancelSlashCommand = useCallback(() => {
    setPendingSlashMessage(null)
  }, [])

  // Q6 / SS-5: stop the agent's response from the sidebar composer.
  // Resolves the tmux window through `tmuxStatus` + `sessionAgentMap`,
  // mirroring SessionDetailPage so the two surfaces share behaviour.
  const handleSidebarInterrupt = useCallback(async () => {
    if (!sidebarSessionId || !tmuxStatus?.hasSession) return
    const agentId = sessionAgentMap[sidebarSessionId]
    if (!agentId) return
    const windowName = tmuxStatus.agentWindowMap?.[agentId]
    if (!windowName) return
    try {
      await tmuxInterrupt(windowName)
    } catch {
      // best-effort
    }
  }, [sidebarSessionId, tmuxStatus, sessionAgentMap, tmuxInterrupt])

  // Auto-scroll the simple message list to the bottom on new events.
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sidebarEvents = useMemo(() => {
    if (!sidebarSessionId || !currentSession || currentSession.id !== sidebarSessionId) return []
    return currentSession.events.filter(
      (e) => (e.type === 'user' || e.type === 'assistant') && !isSystemOnlyMessage(e),
    )
  }, [sidebarSessionId, currentSession])

  // Typing indicator state — mirrors ChatTimeline's behavior so the
  // sidebar surfaces "agent is preparing a reply" feedback while the
  // server is producing the next assistant turn. We trigger on either
  // the local optimistic flag (right after send) or the session-level
  // status that the server pushes via WS (`thinking` / `waiting`).
  const sidebarSession = useMemo(
    () => (sidebarSessionId ? sessions.find((s) => s.id === sidebarSessionId) ?? null : null),
    [sessions, sidebarSessionId],
  )
  const selectedAgent = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId],
  )
  const showTypingIndicator =
    selectedAgentId !== null &&
    selectedAgent !== null &&
    (isSending ||
      sidebarSession?.status === 'thinking' ||
      sidebarSession?.status === 'waiting')

  // File preview state — the ambient sidebar opens its own FilePreview
  // panel so file-path links inside messages stay actionable on the
  // surfaces where the sidebar is shown (sidebar is suppressed on the
  // Sessions screen, which already owns its own FilePreview, so the two
  // never coexist).
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)
  // Q7 / AS-5: pre-flight the link before opening the modal. Plain
  // URLs (http:// / https://) skip the modal and open in a new tab —
  // KB has no privileged data to add for them, and the modal would
  // just be a worse browsing surface. Anything else is treated as a
  // file path and routed to the read-only preview panel.
  const handleFilePathClick = useCallback((path: string) => {
    if (/^https?:\/\//i.test(path)) {
      window.open(path, '_blank', 'noopener,noreferrer')
      return
    }
    setPreviewFilePath(path)
  }, [])
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [sidebarEvents.length, showTypingIndicator])

  const [width, setWidth] = useState<number>(() => loadStoredWidth())
  const [isResizing, setIsResizing] = useState(false)

  // Persist width whenever it settles (skip while actively dragging to
  // avoid hammering localStorage on every mousemove).
  useEffect(() => {
    if (isResizing) return
    persistWidth(width)
  }, [width, isResizing])

  // --- Resize handling ---
  // We compute the new width from the viewport edge: since the sidebar
  // is right-anchored, width = window.innerWidth - clientX.
  const handlePointerDownRef = useRef<(event: React.PointerEvent<HTMLDivElement>) => void>(null!)
  handlePointerDownRef.current = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isOpen) return
    event.preventDefault()
    setIsResizing(true)

    const onMove = (e: PointerEvent) => {
      const next = window.innerWidth - e.clientX
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))
      setWidth(clamped)
    }
    const onUp = () => {
      setIsResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    handlePointerDownRef.current(event)
  }, [])

  // While resizing: prevent text selection across the page and force a
  // global col-resize cursor so the user gets continuous feedback even
  // when the pointer moves outside the handle's hit area.
  useEffect(() => {
    if (!isResizing) return
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
    }
  }, [isResizing])

  const renderedWidth = isOpen ? width : COLLAPSED_WIDTH

  return (
    <aside
      data-testid="ambient-sidebar"
      data-state={isOpen ? 'open' : 'closed'}
      style={{ width: `${renderedWidth}px` }}
      className={`
        relative h-full bg-[var(--bg-surface)] border-l border-[var(--border)]
        flex flex-col shrink-0
        ${isResizing ? '' : 'transition-[width] duration-200'}
      `}
    >
      {/* Resize handle — left edge, only active when open */}
      {isOpen && (
        <div
          data-testid="ambient-sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('ambientSidebar.resize.handle')}
          onPointerDown={onResizePointerDown}
          className="
            absolute left-0 top-0 bottom-0 w-1 -ml-0.5 z-10
            cursor-col-resize
            hover:bg-[var(--accent-border)]/40
            active:bg-[var(--accent-border)]/60
            transition-colors
          "
        />
      )}

      {/* Toggle row — kept reachable in both states. Hosts the
          per-app action menu (⋯) on the left when an app is focused
          (DEC-024 #5 / spec §F3); collapses to just the toggle when
          the sidebar itself is closed. */}
      <div className="flex items-center justify-between border-b border-[var(--border)] h-10 px-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isOpen && currentAppId !== null && (() => {
            // Resolve the focused app's wire metadata so the
            // popover can route actions safely. The source /
            // manifestState / recipeId fields are populated by
            // `loadUserMenuEntries()`; without them, the popover
            // would default to the destructive Remove branch
            // even for bundled / sample apps -- the very HIGH
            // codex flagged in attempt 21.
            const focused = userMenuEntries.find(
              (entry) => entry.id === currentAppId,
            )
            const focusedDisplayName =
              currentAppDisplayName ?? currentAppId
            return (
              <div className="relative">
                <AppActionsMenuButton
                  appId={currentAppId}
                  isOpen={isAppActionsOpen}
                  onToggle={() => setIsAppActionsOpen((v) => !v)}
                />
                <AppActionsPopover
                  isOpen={isAppActionsOpen}
                  onClose={() => setIsAppActionsOpen(false)}
                  // The sidebar is pinned to the right edge of the
                  // viewport and its column can shrink to its minimum
                  // width, so a left-anchored popover (default) would
                  // expand past the window edge and become unclickable.
                  // Anchor to the right edge and expand leftward instead.
                  align="right"
                  source={focused?.source}
                  manifestState={focused?.manifestState}
                  onSelectExport={() =>
                    onRequestRecipeExport({
                      appId: currentAppId,
                      displayName: focusedDisplayName,
                    })
                  }
                  onSelectRemoval={() =>
                    onRequestAppRemoval({
                      appId: currentAppId,
                      displayName: focusedDisplayName,
                    })
                  }
                  onSelectDisable={
                    // Only wire Disable when the focused entry
                    // actually has the recipe lineage required by
                    // `POST /api/recipes/sample/:recipeId/disable`.
                    // The popover renders the Disable button
                    // disabled when no callback is provided, so
                    // missing-lineage rows visibly surface the
                    // unavailable state instead of silently
                    // falling through to destructive Remove.
                    focused?.recipeId &&
                    (focused.source === 'bundled' ||
                      focused.source === 'sample')
                      ? () =>
                          onRequestSampleDisable({
                            appId: currentAppId,
                            recipeId: focused.recipeId as string,
                            displayName: focusedDisplayName,
                          })
                      : undefined
                  }
                />
              </div>
            )
          })()}
          {/* AS-1: heading row removed — it duplicated the picker
              label below it, and the toggle button on the right
              already conveys "this is the sidebar". */}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {/* AS-6 / Q8: open the current sidebar session in the
              dedicated /sessions screen. Hidden when the sidebar is
              collapsed (no header room) or there is no current
              session yet (the user has not started a sidebar
              conversation). The input draft is intentionally NOT
              transferred — v0.1.0 keeps the affordance simple; a
              transfer mechanism is tracked for v0.1.1. */}
          {isOpen && currentSession && (
            <button
              type="button"
              data-testid="ambient-sidebar-open-in-sessions"
              onClick={() => navigate(`/sessions/${currentSession.id}`)}
              title={t('ambientSidebar.openInSessions')}
              aria-label={t('ambientSidebar.openInSessions')}
              className="
                flex items-center justify-center w-8 h-8 rounded
                text-[var(--text-dim)] hover:text-[var(--text-tertiary)]
                hover:bg-[var(--bg-elevated)] transition-colors
              "
            >
              {/* arrow-up-right-from-square */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 4h6v6" />
                <path d="M20 4l-8 8" />
                <path d="M14 14v6H4V4h6" />
              </svg>
            </button>
          )}
          <button
            type="button"
            data-testid="ambient-sidebar-toggle"
            onClick={() => setIsOpen((prev) => !prev)}
            title={isOpen ? t('ambientSidebar.toggle.collapse') : t('ambientSidebar.toggle.expand')}
            aria-label={isOpen ? t('ambientSidebar.toggle.collapse') : t('ambientSidebar.toggle.expand')}
            aria-expanded={isOpen}
            className="
              flex items-center justify-center w-8 h-8 rounded
              text-[var(--text-dim)] hover:text-[var(--text-tertiary)]
              hover:bg-[var(--bg-elevated)] transition-colors
            "
          >
            {isOpen ? (
              /* chevron right (collapse) */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            ) : (
              /* chevron left (expand) */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Body — Phase 2-B: agent picker + pin. Chat surface arrives in 2-C. */}
      {isOpen && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Picker row */}
          <div className="px-3 pt-3 pb-2 border-b border-[var(--border)] flex flex-col gap-2">
            <label
              htmlFor="ambient-sidebar-agent-picker"
              className="text-[11px] font-medium text-[var(--text-muted)]"
            >
              {t('ambientSidebar.picker.label')}
            </label>
            <AgentPicker
              id="ambient-sidebar-agent-picker"
              selectedAgentId={selectedAgentId}
              agents={agents}
              disabled={settingsLoading || agents.length === 0}
              onChange={setSelectedAgentId}
              theme={theme}
            />
            <button
              type="button"
              data-testid="ambient-sidebar-pin-button"
              onClick={handlePin}
              disabled={pinning || settingsLoading || appId === null || isPinnedToCurrent}
              title={
                isPinnedToCurrent
                  ? t('ambientSidebar.pin.alreadyPinned')
                  : t('ambientSidebar.pin.button')
              }
              className="
                self-start text-xs px-2 py-1 rounded
                bg-[var(--bg-elevated)] text-[var(--text-secondary)]
                border border-[var(--border)]
                hover:bg-[var(--accent-bg)] hover:text-[var(--accent-text)]
                disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[var(--bg-elevated)]
                transition-colors
              "
            >
              {isPinnedToCurrent
                ? t('ambientSidebar.pin.alreadyPinned')
                : t('ambientSidebar.pin.button')}
            </button>
          </div>

          {/* Chat surface — Phase 2-C minimal implementation. A
              richer timeline (tool calls, attachments) lands later. */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div
              data-testid="ambient-sidebar-messages"
              className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
            >
              {!selectedAgentId && (
                <div className="text-center text-xs text-[var(--text-dim)] mt-6">
                  {t('ambientSidebar.placeholder')}
                </div>
              )}
              {selectedAgentId && sidebarEvents.length === 0 && (
                <div className="text-center text-xs text-[var(--text-dim)] mt-6">
                  {t('ambientSidebar.chat.empty')}
                </div>
              )}
              {sidebarEvents.map((e) => {
                const isUser = e.type === 'user'
                const text = e.content.text ?? ''
                if (!text) return null
                // For user messages, peel KB-authored sections off so
                // they render as collapsible chips and the actual
                // user-typed text remains visible inline.
                const parsed = isUser ? parseKbAuthoredSections(text) : null
                const hasSections = parsed !== null && parsed.sections.length > 0
                const userInputForRender = parsed ? parsed.userInput : text
                return (
                  <div
                    key={e.id}
                    data-testid="ambient-sidebar-message"
                    data-role={isUser ? 'user' : 'assistant'}
                    className={`ambient-sidebar-message text-[12px] leading-relaxed rounded px-2 py-1.5 break-words
                      ${isUser
                        ? 'bg-[var(--accent-bg)]/30 text-[var(--text-secondary)] ml-6'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-tertiary)] mr-6'}`}
                  >
                    {isUser ? (
                      <>
                        {hasSections && (
                          <KbAuthoredSections
                            sections={parsed!.sections}
                            compact
                          />
                        )}
                        {userInputForRender.length > 0 && (
                          <UserMessageText
                            text={userInputForRender}
                            onFilePathClick={handleFilePathClick}
                          />
                        )}
                      </>
                    ) : (
                      <MarkdownPreview content={text} onFilePathClick={handleFilePathClick} />
                    )}
                  </div>
                )
              })}

              {/* Typing indicator — mirrors ChatTimeline's 3-dot pulse so
                  the sidebar surfaces "agent is preparing a reply" feedback
                  while either the local send is in flight or the session
                  status is `thinking` / `waiting`. Sized down vs. the main
                  chat surface to fit the narrow sidebar width. */}
              {showTypingIndicator && (
                <div
                  data-testid="ambient-sidebar-typing-indicator"
                  className="flex justify-start mr-6"
                >
                  <div className="flex items-center gap-1 px-2 py-1.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)]">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor: selectedAgent!.color,
                        animation: 'pulse-dot 1.4s ease-in-out infinite',
                        animationDelay: '0s',
                      }}
                    />
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor: selectedAgent!.color,
                        animation: 'pulse-dot 1.4s ease-in-out infinite',
                        animationDelay: '0.2s',
                      }}
                    />
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor: selectedAgent!.color,
                        animation: 'pulse-dot 1.4s ease-in-out infinite',
                        animationDelay: '0.4s',
                      }}
                    />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/*
              Composer: the bespoke textarea was replaced by the shared
              <MessageInput> component so AmbientSidebar inherits paste,
              drop, file picker, screenshot capture, and vertical resize
              for free. The picked-element pill stays above the input
              (it is sidebar-specific UX); the pick toggle stays below
              it on its own row alongside the keyboard-shortcut hint.
            */}
            <div className="border-t border-[var(--border)] flex flex-col">
              {sendError && (
                <p className="text-[10px] text-red-400 truncate px-3 pt-2" title={sendError}>
                  {sendError}
                </p>
              )}

              {/* α-method: picked-element pill */}
              {pickedDescription && (
                <div
                  data-testid="ambient-sidebar-picked-pill"
                  className="
                    mx-2 mt-2
                    flex items-center justify-between gap-2 text-[10px]
                    rounded px-2 py-1 bg-[var(--accent-bg)]/40 border border-[var(--accent-border)]/40
                    text-[var(--text-secondary)]
                  "
                >
                  <span className="truncate" title={t('ambientSidebar.pick.includedHint')}>
                    {t('ambientSidebar.pick.included')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPickedDescription(null)}
                    className="text-[var(--text-dim)] hover:text-[var(--text-tertiary)] shrink-0"
                  >
                    {t('ambientSidebar.pick.clear')}
                  </button>
                </div>
              )}

              <MessageInput
                onSend={handleSend}
                isSending={isSending}
                isAgentBusy={
                  !!sidebarSessionId &&
                  !!currentSession &&
                  currentSession.id === sidebarSessionId &&
                  (currentSession.status === 'thinking' ||
                    currentSession.status === 'waiting')
                }
                onInterrupt={handleSidebarInterrupt}
                value={draft}
                onChange={setDraft}
                disabled={!selectedAgentId}
                placeholder={
                  selectedAgentId
                    ? t('ambientSidebar.composer.placeholder')
                    : t('ambientSidebar.composer.pickAgentFirst')
                }
                compact
                resizable
                storageKey="ambient"
                /* AS-3: tighter starting height for the narrow sidebar
                   surface. Users can still drag the resize handle to
                   make it taller and the new value is persisted. */
                initialHeight={60}
                /* AS-4: screen-capture button removed from the sidebar.
                   Image input is still possible by pasting (handled by
                   MessageInput's onPaste). The hint row below mentions
                   the paste affordance. */
              />

              {/* Sidebar-specific actions row: pick toggle + shortcut hint. */}
              <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1">
                <button
                  type="button"
                  data-testid="ambient-sidebar-pick-toggle"
                  onClick={togglePicking}
                  disabled={!selectedAgentId}
                  title={isPicking ? t('ambientSidebar.pick.cancel') : t('ambientSidebar.pick.start')}
                  className={`
                    text-[10px] px-2 py-1 rounded border transition-colors
                    ${isPicking
                      ? 'bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]'
                      : 'bg-[var(--bg-elevated)] text-[var(--text-dim)] border-[var(--border)] hover:text-[var(--text-tertiary)]'}
                    disabled:opacity-50 disabled:cursor-not-allowed
                  `}
                >
                  {isPicking ? t('ambientSidebar.pick.cancel') : t('ambientSidebar.pick.start')}
                </button>
                <span className="text-[10px] text-[var(--text-faint)] flex-1 text-right">
                  {t('ambientSidebar.composer.pasteHint')} · {t('ambientSidebar.composer.shortcut')}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* File preview overlay — opened by message file-path links. The
          ambient sidebar is suppressed on the Sessions screen, which
          owns its own FilePreview, so the two surfaces never overlap. */}
      {previewFilePath && (
        <FilePreview
          filePath={previewFilePath}
          onClose={() => setPreviewFilePath(null)}
        />
      )}
      <SlashCommandWarningModal
        message={pendingSlashMessage}
        onConfirm={handleConfirmSlashCommand}
        onCancel={handleCancelSlashCommand}
      />
    </aside>
  )
}

// ===================================================================
// AgentPicker — custom dropdown that shows the agent avatar alongside
// the display name. Replaces the native <select> (which can't render
// images) so the user can recognize agents visually before sending.
// ===================================================================

interface AgentPickerProps {
  id: string
  selectedAgentId: string | null
  agents: AgentInfo[]
  disabled: boolean
  onChange: (id: string | null) => void
  theme: 'dark' | 'light'
}

function AgentPicker({ id, selectedAgentId, agents, disabled, onChange, theme }: AgentPickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId],
  )

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const handleSelect = (agentId: string | null) => {
    onChange(agentId)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        id={id}
        data-testid="ambient-sidebar-agent-picker"
        // Carry the previous select's value semantics for any test that
        // reads the picker's state via `data-value`.
        data-value={selectedAgentId ?? ''}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="
          w-full text-sm rounded border border-[var(--border)]
          bg-[var(--bg-elevated)] text-[var(--text-secondary)]
          px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
          disabled:opacity-50 disabled:cursor-not-allowed
          flex items-center gap-2 text-left
        "
      >
        {selected ? (
          <>
            <AgentAvatar
              name={selected.displayName}
              color={selected.color}
              avatar={selected.avatar}
              agentId={selected.id}
              size={20}
              theme={theme}
            />
            <span className="flex-1 truncate">{selected.displayName}</span>
          </>
        ) : (
          <span className="flex-1 text-[var(--text-dim)]">
            {t('ambientSidebar.picker.unselected')}
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 opacity-60"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-labelledby={id}
          data-testid="ambient-sidebar-agent-picker-list"
          className="
            absolute z-20 mt-1 left-0 right-0 max-h-60 overflow-y-auto
            rounded border border-[var(--border)]
            bg-[var(--bg-elevated)] shadow-lg
            text-sm py-1
          "
        >
          <li
            role="option"
            aria-selected={selectedAgentId === null}
            tabIndex={0}
            onClick={() => handleSelect(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleSelect(null)
              }
            }}
            className="
              px-2 py-1.5 cursor-pointer text-[var(--text-dim)]
              hover:bg-[var(--bg-hover)]
            "
          >
            {t('ambientSidebar.picker.unselected')}
          </li>
          {agents.map((agent) => {
            const isSelected = agent.id === selectedAgentId
            return (
              <li
                key={agent.id}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                data-testid={`ambient-sidebar-agent-picker-option-${agent.id}`}
                onClick={() => handleSelect(agent.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleSelect(agent.id)
                  }
                }}
                className={`
                  px-2 py-1.5 cursor-pointer text-[var(--text-secondary)]
                  hover:bg-[var(--bg-hover)] flex items-center gap-2
                  ${isSelected ? 'bg-[var(--bg-hover)]' : ''}
                `}
              >
                <AgentAvatar
                  name={agent.displayName}
                  color={agent.color}
                  avatar={agent.avatar}
                  agentId={agent.id}
                  size={20}
                  theme={theme}
                />
                <span className="flex-1 truncate">{agent.displayName}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
