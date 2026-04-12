import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
  TrustPromptKind,
} from '../../shared/ws-events'
import type { TrustPromptItem } from '../hooks/useIPC'

/**
 * 信頼プロンプト中継モーダル（Phase 5c / 5d）
 *
 * サーバー側 trust-prompt-detector が検知したプロンプトを UI に表示する。
 *
 * - detected モード: パターンマッチ済み。選択肢ボタンで応答する
 * - fallback モード: 未知プロンプト。生バッファ表示 + 自由入力 + よく使うキー
 *   ボタンで raw-keys 応答する
 *
 * Props:
 * - item: null のときは非表示。非 null になるとオーバーレイで表示される
 * - onChoice: detected モードで選択肢ボタンを押したとき
 * - onRawKeys: fallback モードで raw-keys を送信するとき
 * - onDismiss: ESC / オーバーレイクリックで閉じるとき
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

/** よく使うキーボタン定義（仕様書 §5-3-1） */
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

  // イベントが切り替わったら内部状態をリセット
  useEffect(() => {
    setShowRawBuffer(false)
    setRawKeysInput('')
    setCopied(false)
  }, [promptId])

  // fallback モードではバッファを常に展開する
  useEffect(() => {
    if (item?.kind === 'fallback') {
      setShowRawBuffer(true)
    }
  }, [item?.kind, promptId])

  // fallback モードで表示されたら自由入力フィールドにフォーカス
  useEffect(() => {
    if (item?.kind === 'fallback' && inputRef.current) {
      // DOM が描画された後にフォーカスするため requestAnimationFrame
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [item?.kind, promptId])

  // ESC キーで閉じる
  useEffect(() => {
    if (!item) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [item, onDismiss])

  // 自由入力フィールドの送信ハンドラ
  const handleRawKeysSubmit = useCallback(() => {
    const trimmed = rawKeysInput.trim()
    if (!trimmed) return
    onRawKeys(trimmed)
    setRawKeysInput('')
  }, [rawKeysInput, onRawKeys])

  // tmux attach コマンドのコピー
  const handleCopyTmuxCommand = useCallback(async (windowName: string) => {
    const cmd = `tmux attach -t "${windowName}"`
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API が使えない場合は警告のみ
      console.warn('[trust-prompt] クリップボードへのコピーに失敗')
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

  // fallback モード
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* オーバーレイ */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onDismiss}
      />

      {/* モーダル本体 */}
      <div
        className="relative w-full max-w-2xl mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-prompt-modal-title"
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2
            id="trust-prompt-modal-title"
            className="text-lg font-semibold text-[var(--text-secondary)] flex items-center gap-2"
          >
            <span className="text-2xl leading-none" aria-hidden>
              ❓
            </span>
            <span>未知の入力待ち</span>
          </h2>
          <CloseButton onClick={onDismiss} />
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* メタ情報 */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-dim)]">
            <span className="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border)]">
              window: <span className="text-[var(--text-tertiary)] font-mono">{windowName}</span>
            </span>
            <span className="px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/40 text-amber-200">
              フォールバック
            </span>
          </div>

          {/* 警告バナー */}
          <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm flex items-start gap-2">
            <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
            <div>
              <div className="font-semibold mb-0.5">パターン定義に一致しないプロンプトです</div>
              <div className="text-xs opacity-90">
                下の生バッファを確認し、自由入力欄またはキーボタンで応答してください。
              </div>
            </div>
          </div>

          {/* 生バッファ（fallback では常に展開） */}
          <RawBufferSection
            rawBuffer={rawBuffer}
            show={showRawBuffer}
            onToggle={() => setShowRawBuffer((v) => !v)}
          />

          {/* よく使うキーボタン */}
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

          {/* 自由入力フィールド */}
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

          {/* tmux attach コマンドコピペ */}
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

// ===== 内部サブコンポーネント =====

/** detected モード用モーダル（Phase 5c から構造を移植） */
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

  // detail から表示する key-value ペアを抽出（null 値は除外）
  const detailEntries = Object.entries(event.detail).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  ) as [string, string][]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* オーバーレイ */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onDismiss}
      />

      {/* モーダル本体 */}
      <div
        className="relative w-full max-w-2xl mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-prompt-modal-title"
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2
            id="trust-prompt-modal-title"
            className="text-lg font-semibold text-[var(--text-secondary)] flex items-center gap-2"
          >
            <span className="text-2xl leading-none" aria-hidden>
              {kindIcon}
            </span>
            <span>信頼確認: {kindLabel}</span>
          </h2>
          <CloseButton onClick={onDismiss} />
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* メタ情報バー */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-dim)]">
            <span className="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border)]">
              window: <span className="text-[var(--text-tertiary)] font-mono">{event.windowName}</span>
            </span>
            <span className="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border)]">
              pattern: <span className="text-[var(--text-tertiary)] font-mono">{event.patternId}</span>
            </span>
          </div>

          {/* degenerate 警告バナー */}
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

          {/* 抽出された詳細 */}
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
                    <dd className="flex-1 min-w-0 text-[var(--text-tertiary)] font-mono text-xs break-all">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* 生バッファ折り畳み */}
          <RawBufferSection
            rawBuffer={event.rawBuffer}
            show={showRawBuffer}
            onToggle={onToggleRawBuffer}
          />
        </div>

        {/* 選択肢ボタン（フッター） */}
        <div className="px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-surface)] flex flex-col-reverse sm:flex-row sm:flex-wrap gap-2 sm:justify-end">
          {event.choices.length === 0 ? (
            <div className="text-xs text-[var(--text-dim)] self-center">
              選択肢がありません（パターン定義を確認してください）
            </div>
          ) : (
            event.choices.map((choice, idx) => {
              // 1 番目を primary として強調
              const isPrimary = idx === 0
              return (
                <button
                  key={choice.id}
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

/** 閉じるボタン（共通） */
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

/** 生バッファ折り畳みセクション（detected / fallback 共通） */
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
