/**
 * Structured Field Editor
 *
 * UI for individually editing marker-delimited sections
 * (personality, tone sample, extra instructions) within agent definition files.
 */

import { useState, useCallback } from 'react'

/** Data for editable sections */
export interface SectionData {
  displayName: string
  personality: string
  toneSample: string
  extraInstructions: string
}

interface StructuredFieldEditorProps {
  /** Initial values */
  initial: SectionData
  /** Whether markers exist (section editing is disabled when false) */
  hasMarkers: boolean
  /** Whether saving is in progress */
  isSaving: boolean
  /** Save handler */
  onSave: (data: SectionData) => void
  /** Cancel handler */
  onCancel: () => void
}

export function StructuredFieldEditor({
  initial,
  hasMarkers,
  isSaving,
  onSave,
  onCancel,
}: StructuredFieldEditorProps) {
  const [displayName, setDisplayName] = useState(initial.displayName)
  const [personality, setPersonality] = useState(initial.personality)
  const [toneSample, setToneSample] = useState(initial.toneSample)
  const [extraInstructions, setExtraInstructions] = useState(initial.extraInstructions)

  // Check if there are changes
  const hasChanges =
    displayName !== initial.displayName ||
    personality !== initial.personality ||
    toneSample !== initial.toneSample ||
    extraInstructions !== initial.extraInstructions

  const handleSave = useCallback(() => {
    onSave({ displayName, personality, toneSample, extraInstructions })
  }, [displayName, personality, toneSample, extraInstructions, onSave])

  return (
    <div className="space-y-5">
      {/* Display name -- editable regardless of marker presence */}
      <FieldSection
        label="表示名"
        description="UI 上で表示されるエージェント名。空欄の場合はファイル名から自動生成されます。"
      >
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="(自動)"
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
        />
      </FieldSection>

      {/* Warning when markers are absent */}
      {!hasMarkers && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400 shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <p className="text-sm text-yellow-300 font-medium">手動作成のエージェントファイルです</p>
            <p className="text-xs text-[var(--text-dim)] mt-0.5">
              構造化フィールドマーカー（KB:*）が含まれていないため、性格・口調・追加指示の編集はできません。
              表示名のみ変更可能です。
            </p>
          </div>
        </div>
      )}

      {/* Structured fields -- editable only when markers are present */}
      <FieldSection
        label="性格"
        description="エージェントの基本的な性格特性を箇条書きで定義します。"
        disabled={!hasMarkers}
      >
        <textarea
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          disabled={!hasMarkers}
          rows={5}
          placeholder="- 明るく前向き&#10;- 丁寧な対応&#10;- ..."
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed font-mono"
        />
      </FieldSection>

      <FieldSection
        label="口調サンプル"
        description="エージェントの口調の具体例を記述します。会話例やトーンの特徴を含めてください。"
        disabled={!hasMarkers}
      >
        <textarea
          value={toneSample}
          onChange={(e) => setToneSample(e.target.value)}
          disabled={!hasMarkers}
          rows={5}
          placeholder="（例）&#10;ユーザー: こんにちは&#10;エージェント: ..."
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed font-mono"
        />
      </FieldSection>

      <FieldSection
        label="追加指示"
        description="標準の指示に加えてエージェントに与える追加のルールや制約を記述します。"
        disabled={!hasMarkers}
      >
        <textarea
          value={extraInstructions}
          onChange={(e) => setExtraInstructions(e.target.value)}
          disabled={!hasMarkers}
          rows={4}
          placeholder="（任意）特別な制約やルールがあればここに記述してください"
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed font-mono"
        />
      </FieldSection>

      {/* Action buttons */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className={`
            px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-200
            ${hasChanges && !isSaving
              ? 'bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90'
              : 'bg-[var(--bg-surface)] text-[var(--text-faint)] cursor-not-allowed'}
          `}
        >
          {isSaving ? '保存中...' : '保存'}
        </button>
        <button
          onClick={onCancel}
          disabled={isSaving}
          className="px-4 py-2.5 text-sm text-[var(--text-dim)] hover:text-[var(--text-tertiary)] transition-colors"
        >
          キャンセル
        </button>
        {hasChanges && !isSaving && (
          <span className="text-[10px] text-[var(--text-faint)]">未保存の変更があります</span>
        )}
      </div>
    </div>
  )
}

// --- Field section ---

interface FieldSectionProps {
  label: string
  description: string
  disabled?: boolean
  children: React.ReactNode
}

function FieldSection({ label, description, disabled, children }: FieldSectionProps) {
  return (
    <div className={disabled ? 'opacity-60' : ''}>
      <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
        {label}
      </label>
      <p className="text-[10px] text-[var(--text-faint)] mb-2">{description}</p>
      {children}
    </div>
  )
}
