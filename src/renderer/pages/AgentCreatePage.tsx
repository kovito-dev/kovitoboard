/**
 * Agent creation page
 *
 * Step 1: Select a template
 * Step 2: Enter agent ID and display name, then create
 */

import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTemplates, type TemplateSummary } from '../hooks/useTemplates'

type Step = 'select-template' | 'configure'

/** Check whether the given string is a valid agent ID */
function isValidAgentId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) && id.length <= 64
}

/** Shorten a model name for display */
function shortModel(model: string): string {
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

export function AgentCreatePage() {
  const navigate = useNavigate()
  const { templates, isLoading, error: fetchError } = useTemplates()

  const [step, setStep] = useState<Step>('select-template')
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSummary | null>(null)
  const [agentId, setAgentId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Select a template
  const handleSelectTemplate = useCallback((template: TemplateSummary) => {
    setSelectedTemplate(template)
    // Generate a default agentId from the template name
    setAgentId(template.id)
    setDisplayName('')
    setCreateError(null)
    setStep('configure')
  }, [])

  // Back button
  const handleBack = useCallback(() => {
    if (step === 'configure') {
      setStep('select-template')
      setCreateError(null)
    } else {
      navigate('/agents')
    }
  }, [step, navigate])

  // agentId validation
  const idValidation = useMemo(() => {
    if (!agentId) return { valid: false, message: '' }
    if (!isValidAgentId(agentId)) {
      return { valid: false, message: '英数字・ハイフン・アンダースコアのみ（先頭は英数字）' }
    }
    return { valid: true, message: '' }
  }, [agentId])

  // Create agent
  const handleCreate = useCallback(async () => {
    if (!selectedTemplate || !idValidation.valid) return

    setIsCreating(true)
    setCreateError(null)

    try {
      const res = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: selectedTemplate.id,
          agentId,
          displayName: displayName || undefined,
        }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error || `Creation failed (${res.status})`)
      }

      // Success — navigate to agents list
      navigate('/agents')
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create agent')
    } finally {
      setIsCreating(false)
    }
  }, [selectedTemplate, agentId, displayName, idValidation.valid, navigate])

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6">
      {/* ヘッダー */}
      <div className="mb-6">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 text-sm text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors mb-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {step === 'configure' ? 'テンプレート選択に戻る' : 'エージェント一覧に戻る'}
        </button>
        <h2 className="text-lg font-semibold text-[var(--text-secondary)]">
          エージェントを追加
        </h2>
        <p className="text-sm text-[var(--text-dim)] mt-1">
          {step === 'select-template'
            ? 'テンプレートを選択してください'
            : 'エージェントの設定を確認してください'}
        </p>
      </div>

      {/* Step 1: テンプレート選択 */}
      {step === 'select-template' && (
        <TemplateSelector
          templates={templates}
          isLoading={isLoading}
          error={fetchError}
          onSelect={handleSelectTemplate}
        />
      )}

      {/* Step 2: 設定確認・作成 */}
      {step === 'configure' && selectedTemplate && (
        <ConfigureStep
          template={selectedTemplate}
          agentId={agentId}
          displayName={displayName}
          idValidation={idValidation}
          isCreating={isCreating}
          createError={createError}
          onAgentIdChange={setAgentId}
          onDisplayNameChange={setDisplayName}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}

// --- Template selector component ---

interface TemplateSelectorProps {
  templates: TemplateSummary[]
  isLoading: boolean
  error: string | null
  onSelect: (template: TemplateSummary) => void
}

function TemplateSelector({ templates, isLoading, error, onSelect }: TemplateSelectorProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-[var(--text-dim)]">テンプレートを読み込み中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <div className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg p-6 text-center">
        <p className="text-sm text-[var(--text-dim)]">利用可能なテンプレートがありません</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((template) => (
        <button
          key={template.id}
          onClick={() => onSelect(template)}
          className="text-left bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl p-5 hover:bg-[var(--bg-hover)] hover:border-[var(--accent-border)] transition-all duration-200 group"
        >
          <div className="flex items-start justify-between mb-2">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] group-hover:text-[var(--accent-text)] transition-colors">
              {template.name}
            </h3>
            <span className="text-[10px] text-[var(--text-faint)] bg-[var(--bg-surface)] px-2 py-0.5 rounded-full">
              {shortModel(template.model)}
            </span>
          </div>
          <p className="text-xs text-[var(--text-muted)] line-clamp-3 leading-relaxed">
            {template.description}
          </p>
          <div className="mt-3 flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            {template.id}
          </div>
        </button>
      ))}
    </div>
  )
}

// --- Configure and create component ---

interface ConfigureStepProps {
  template: TemplateSummary
  agentId: string
  displayName: string
  idValidation: { valid: boolean; message: string }
  isCreating: boolean
  createError: string | null
  onAgentIdChange: (value: string) => void
  onDisplayNameChange: (value: string) => void
  onCreate: () => void
}

function ConfigureStep({
  template,
  agentId,
  displayName,
  idValidation,
  isCreating,
  createError,
  onAgentIdChange,
  onDisplayNameChange,
  onCreate,
}: ConfigureStepProps) {
  return (
    <div className="max-w-lg">
      {/* テンプレート情報 */}
      <div className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-faint)]">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-xs text-[var(--text-dim)]">テンプレート</span>
        </div>
        <p className="text-sm font-medium text-[var(--text-secondary)]">{template.name}</p>
        <p className="text-xs text-[var(--text-muted)] mt-1">{template.description}</p>
      </div>

      {/* フォーム */}
      <div className="space-y-4">
        {/* エージェント ID */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            エージェント ID <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={agentId}
            onChange={(e) => onAgentIdChange(e.target.value)}
            placeholder="my-agent"
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          />
          {idValidation.message && (
            <p className="text-xs text-red-400 mt-1">{idValidation.message}</p>
          )}
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            ファイル名として使用されます: <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">.claude/agents/{agentId || '...'}.md</code>
          </p>
        </div>

        {/* 表示名 */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            表示名 <span className="text-[var(--text-faint)]">(任意)</span>
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder={template.name}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          />
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            未入力の場合はテンプレートの名前が使用されます
          </p>
        </div>
      </div>

      {/* エラー表示 */}
      {createError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mt-4">
          <p className="text-sm text-red-400">{createError}</p>
        </div>
      )}

      {/* 作成ボタン */}
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={onCreate}
          disabled={!idValidation.valid || isCreating}
          className={`
            px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-200
            ${idValidation.valid && !isCreating
              ? 'bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90'
              : 'bg-[var(--bg-surface)] text-[var(--text-faint)] cursor-not-allowed'}
          `}
        >
          {isCreating ? '作成中...' : 'エージェントを作成'}
        </button>
        <p className="text-[10px] text-[var(--text-faint)]">
          Claude Code から <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">claude --agent {agentId || '...'}</code> で起動できます
        </p>
      </div>
    </div>
  )
}
