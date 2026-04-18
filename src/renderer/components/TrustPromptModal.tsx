import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
  TrustPromptKind,
} from '../../shared/ws-events'
import type { TrustPromptItem } from '../hooks/useIPC'

/**
 * Trust prompt relay modal (Phase 5c / 5d)
 *
 * Displays prompts detected by server-side trust-prompt-detector in the UI.
 *
 * - detected mode: pattern-matched prompt. Respond via choice buttons.
 * - fallback mode: unknown prompt. Raw buffer display + free-form input + quick-key
 *   buttons for raw-keys response.
 *
 * Props:
 * - item: hidden when null. Shows overlay when non-null.
 * - onChoice: called when a choice button is pressed in detected mode.
 * - onRawKeys: called when raw-keys are sent in fallback mode.
 * - onDismiss: called on ESC / overlay click to close.
 */

interface TrustPromptModalProps {
  item: TrustPromptItem | null
  onChoice: (choiceId: string) => void
  onRawKeys: (rawKeys: string) => void
  onDismiss: () => void
}

const KIND_LABEL: Record<TrustPromptKind, string> = {
  'folder-trust': 'フォルダ信頼',
  write: 'ファイル書き込み',
  edit: 'ファイル編集',
  bash: 'Bash コマンド実行',
  'sandbox-network': 'ネットワーク（サンドボックス）',
  other: 'その他',
}

const KIND_ICON: Record<TrustPromptKind, string> = {
  'folder-trust': '📁',
  write: '📝',
  edit: '✏️',
  bash: '⚡',
  'sandbox-network': '🌐',
  other: '❓',
}

/** Quick key button definitions (spec section 5-3-1) */
const QUICK_KEYS = [
  { label: 'Enter', keys: 'Enter' },
  { label: 'Escape', keys: 'Escape' },
  { label: 'Ctrl+C', keys: 'C-c' },
  { label: 'y', keys: 'y' },
  { label: 'n', keys: 'n' },
  { label: '1', keys: '1' },
  { label: '2', keys: '2' },
  { label: '3', keys: '3' },
] as const

export function TrustPromptModal({
  item,
  onChoice,
  onRawKeys,
  onDismiss,
}: TrustPromptModalProps) {
  const [showRawBuffer, setShowRawBuffer] = useState(false)
  const [rawKeysInput, setRawKeysInput] = useState('')
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const promptId = item?.payload.promptId ?? null

  // Reset internal state when the event changes
  useEffect(() => {
    setShowRawBuffer(false)
    setRawKeysInput('')
    setCopied(false)
  }, [promptId])

  // Always expand buffer in fallback mode
  useEffect(() => {
    if (item?.kind === 'fallback') {
      setShowRawBuffer(true)
    }
  }, [item?.kind, promptId])

  // Focus the free-form input field when fallback mode is displayed
  useEffect(() => {
    if (item?.kind === 'fallback' && inputRef.current) {
      // Use requestAnimationFrame to focus after the DOM has rendered
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [item?.kind, promptId])

  // Close on ESC key
  useEffect(() => {
    if (!item) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [item, onDismiss])

  // Submit handler for free-form input field
  const handleRawKeysSubmit = useCallback(() => {
    const trimmed = rawKeysInput.trim()
    if (!trimmed) return
    onRawKeys(trimmed)
    setRawKeysInput('')
  }, [rawKeysInput, onRawKeys])

  // Copy tmux attach command
  const handleCopyTmuxCommand = useCallback(async (windowName: string) => {
    const cmd = `tmux attach -t "${windowName}"`
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Only warn if clipboard API is unavailable
      console.warn('[trust-prompt] Failed to copy to clipboard')
    }
  }, [])

  if (!item) return null

  const windowName = item.payload.windowName
  const rawBuffer = item.payload.rawBuffer

  if (item.kind === 'detected') {
    return (
      <DetectedModal
        event={item.payload}
        showRawBuffer={showRawBuffer}
        onToggleRawBuffer={() => setShowRawBuffer((v) => !v)}
        onChoice={onChoice}
        onDismiss={onDismiss}
      />
    )
  }

  // Fallback mode
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onDismiss}
      />

      {/* Modal body */}
      <div
        className="relative w-full max-w-2xl mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-prompt-modal-title"
        data-testid="trust-prompt-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2
            id="trust-prompt-modal-title"
            className="text-lg font-semibold text-[var(--text-secondary)] flex items-center gap-2"
          >
            <span className="text-2xl leading-none" aria-hidden>
              ❓
            </span>
            <span data-testid="trust-prompt-kind-label">未知の入力待ち</span>
          </h2>
          <CloseButton onClick={onDismiss} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Meta information */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-dim)]">
            <span className="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border)]">
              window: <span className="text-[var(--text-tertiary)] font-mono">{windowName}</span>
            </span>
            <span className="px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/40 text-amber-200">
              フォールバック
            </span>
          </div>

          {/* Warning banner */}
          <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm flex items-start gap-2">
            <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
            <div>
              <div className="font-semibold mb-0.5">パターン定義に一致しないプロンプトです</div>
              <div className="text-xs opacity-90">
                下の生バッファを確認し、自由入力欄またはキーボタンで応答してください。
              </div>
            </div>
          </div>

          {/* Raw buffer (always expanded in fallback mode) */}
          <RawBufferSection
            rawBuffer={rawBuffer}
            show={showRawBuffer}
            onToggle={() => setShowRawBuffer((v) => !v)}
          />

          {/* Quick key buttons */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-[var(--text-dim)]">
              よく使うキー
            </div>
            <div className="flex flex-wrap gap-2">
              {QUICK_KEYS.map((qk) => (
                <button
                  key={qk.keys}
                  onClick={() => onRawKeys(qk.keys)}
                  className="px-3 py-1.5 rounded-lg text-xs font-mono font-medium bg-[var(--bg-surface)] text-[var(--text-tertiary)] border border-[var(--border)] hover:bg-white/5 hover:text-[var(--text-secondary)] transition-colors"
                >
                  {qk.label}
                </button>
              ))}
            </div>
          </div>

          {/* Free-form input field */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-[var(--text-dim)]">
              自由入力（literal モードで送信されます）
            </div>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={rawKeysInput}
                onChange={(e) => setRawKeysInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    handleRawKeysSubmit()
                  }
                }}
                placeholder="送信する文字列を入力…"
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border)] placeholder-[var(--text-dim)] focus:outline-none focus:border-[var(--accent-border)]"
                maxLength={1024}
              />
              <button
                onClick={handleRawKeysSubmit}
                disabled={!rawKeysInput.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                送信
              </button>
            </div>
          </div>

          {/* tmux attach command copy */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3">
            <div className="text-xs text-[var(--text-dim)] mb-2">
              最終手段: tmux を直接開く
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-2 py-1 text-xs font-mono text-[var(--text-tertiary)] bg-black/20 rounded">
                tmux attach -t &quot;{windowName}&quot;
              </code>
              <button
                onClick={() => handleCopyTmuxCommand(windowName)}
                className="px-3 py-1 rounded-md text-xs font-medium text-[var(--text-dim)] border border-[var(--border)] hover:text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
              >
                {copied ? '✓ コピー済み' : 'コピー'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== Internal sub-components =====

/** Modal for detected mode (structure ported from Phase 5c) */
function DetectedModal({
  event,
  showRawBuffer,
  onToggleRawBuffer,
  onChoice,
  onDismiss,
}: {
  event: TrustPromptDetectedPayload
  showRawBuffer: boolean
  onToggleRawBuffer: () => void
  onChoice: (choiceId: string) => void
  onDismiss: () => void
}) {
  const kindLabel = KIND_LABEL[event.kind] ?? event.kind
  const kindIcon = KIND_ICON[event.kind] ?? '❓'

  // Extract key-value pairs from detail for display (exclude null values)
  const detailEntries = Object.entries(event.detail).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  ) as [string, string][]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onDismiss}
      />

      {/* Modal body */}
      <div
        className="relative w-full max-w-2xl mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-prompt-modal-title"
        data-testid="trust-prompt-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2
            id="trust-prompt-modal-title"
            className="text-lg font-semibold text-[var(--text-secondary)] flex items-center gap-2"
          >
            <span className="text-2xl leading-none" aria-hidden>
              {kindIcon}
            </span>
            <span data-testid="trust-prompt-kind-label">信頼確認: {kindLabel}</span>
          </h2>
          <CloseButton onClick={onDismiss} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Meta information bar */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-dim)]">
            <span className="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border)]">
              window: <span className="text-[var(--text-tertiary)] font-mono">{event.windowName}</span>
            </span>
            <span className="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border)]">
              pattern: <span className="text-[var(--text-tertiary)] font-mono">{event.patternId}</span>
            </span>
          </div>

          {/* Degenerate warning banner */}
          {event.degenerate && (
            <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm flex items-start gap-2">
              <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
              <div>
                <div className="font-semibold mb-0.5">縮退形式のプロンプトを検出しました</div>
                <div className="text-xs opacity-90">
                  選択肢の表示順や個数が通常と異なる可能性があります。送信前に下の「生バッファ」を確認してください。
                </div>
              </div>
            </div>
          )}

          {/* Extracted details */}
          {detailEntries.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden">
              <div className="px-4 py-2 text-xs font-semibold text-[var(--text-dim)] border-b border-[var(--border)]">
                抽出情報
              </div>
              <dl className="divide-y divide-[var(--border)]">
                {detailEntries.map(([key, value]) => (
                  <div key={key} className="px-4 py-2 flex items-start gap-3 text-sm">
                    <dt className="w-28 shrink-0 text-[var(--text-dim)] font-mono text-xs pt-0.5">
                      {key}
                    </dt>
                    <dd
                      className="flex-1 min-w-0 text-[var(--text-tertiary)] font-mono text-xs break-all"
                      data-testid={key === 'path' ? 'trust-prompt-target-file' : undefined}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Raw buffer collapsible */}
          <RawBufferSection
            rawBuffer={event.rawBuffer}
            show={showRawBuffer}
            onToggle={onToggleRawBuffer}
          />
        </div>

        {/* Choice buttons (footer) */}
        <div className="px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-surface)] flex flex-col-reverse sm:flex-row sm:flex-wrap gap-2 sm:justify-end">
          {event.choices.length === 0 ? (
            <div className="text-xs text-[var(--text-dim)] self-center">
              選択肢がありません（パターン定義を確認してください）
            </div>
          ) : (
            event.choices.map((choice, idx) => {
              // Highlight the first item as primary
              const isPrimary = idx === 0
              return (
                <button
                  key={choice.id}
                  data-testid={`trust-prompt-choice-${choice.id}`}
                  onClick={() => onChoice(choice.id)}
                  className={
                    isPrimary
                      ? 'px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 transition-opacity'
                      : 'px-4 py-2 rounded-lg text-sm font-medium bg-transparent text-[var(--text-tertiary)] border border-[var(--border)] hover:bg-white/5 transition-colors'
                  }
                >
                  {choice.label}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

/** Close button (shared) */
function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-2 rounded-lg text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
      aria-label="閉じる"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  )
}

/** Raw buffer collapsible section (shared between detected / fallback) */
function RawBufferSection({
  rawBuffer,
  show,
  onToggle,
}: {
  rawBuffer: string
  show: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-[var(--text-dim)] hover:text-[var(--text-tertiary)] bg-[var(--bg-surface)] transition-colors"
      >
        <span>tmux 生バッファ（末尾）</span>
        <span aria-hidden>{show ? '▲' : '▼'}</span>
      </button>
      {show && (
        <pre className="px-4 py-3 text-[11px] leading-snug font-mono text-[var(--text-tertiary)] bg-black/30 overflow-x-auto whitespace-pre max-h-64">
          {rawBuffer}
        </pre>
      )}
    </div>
  )
}
