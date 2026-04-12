import { useState, useEffect } from 'react'
import type {
  TrustPromptDetectedPayload,
  TrustPromptKind,
} from '../../shared/ws-events'

/**
 * 信頼プロンプト中継モーダル（Phase 5c）
 *
 * サーバー側 trust-prompt-detector が検知したプロンプトを UI に表示し、
 * ユーザーが choice ボタンをクリックすると onChoice が呼ばれる。
 *
 * v0.1.0 Phase 5c 時点では通常パターンマッチ経路 (detected) のみを扱う。
 * fallback (raw-keys 入力) は Phase 5d で拡張する。
 *
 * Props 仕様:
 * - event: null のときは非表示。非 null になるとオーバーレイで表示される
 * - onChoice(choiceId): ユーザーが選択肢ボタンを押したときに呼ばれる
 * - onDismiss: ESC キー / オーバーレイクリックで閉じる（実機では UI を閉じても
 *   サーバー側の state.lastDetectedPromptId は残るため、後で再表示可能）
 */

interface TrustPromptModalProps {
  event: TrustPromptDetectedPayload | null
  onChoice: (choiceId: string) => void
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

export function TrustPromptModal({
  event,
  onChoice,
  onDismiss,
}: TrustPromptModalProps) {
  const [showRawBuffer, setShowRawBuffer] = useState(false)

  // イベントが切り替わったら rawBuffer 折り畳み状態をリセット
  useEffect(() => {
    setShowRawBuffer(false)
  }, [event?.promptId])

  // ESC キーで閉じる
  useEffect(() => {
    if (!event) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [event, onDismiss])

  if (!event) return null

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
          <button
            onClick={onDismiss}
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
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setShowRawBuffer((v) => !v)}
              className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-[var(--text-dim)] hover:text-[var(--text-tertiary)] bg-[var(--bg-surface)] transition-colors"
            >
              <span>tmux 生バッファ（末尾）</span>
              <span aria-hidden>{showRawBuffer ? '▲' : '▼'}</span>
            </button>
            {showRawBuffer && (
              <pre className="px-4 py-3 text-[11px] leading-snug font-mono text-[var(--text-tertiary)] bg-black/30 overflow-x-auto whitespace-pre max-h-64">
                {event.rawBuffer}
              </pre>
            )}
          </div>
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
