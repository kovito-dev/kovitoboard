/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent creation page
 *
 * Step 1: Select a template (or "from scratch" — AA-3)
 * Step 2: Enter agent ID and display name, then create
 *
 * The page handles two creation modes side-by-side:
 *
 *   - Template mode: hands the chosen template id to
 *     POST /api/agents/create. Markers and body content come from
 *     the template; the user only chooses an id + optional display
 *     name.
 *   - Scratch mode: opens a longer form (description / model /
 *     themeColor / systemPrompt) and POSTs to
 *     /api/agents/create-scratch. The output file shape mirrors
 *     what the template path produces, minus the marker block.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTemplates, type TemplateSummary } from '../hooks/useTemplates'
import { AgentAvatar } from '../components/AgentAvatar'
import { getLocale, t } from '../i18n'
import { kbFetch } from '../lib/kbFetch'

type Step = 'select-template' | 'configure'

/**
 * AA-3: identifier the page uses to switch the configure step into
 * "build from scratch" mode without piggybacking on
 * `selectedTemplate` (the template state already carries non-null
 * shapes so a sentinel object would couple to TemplateSummary). The
 * Step 1 picker emits this enum value alongside or instead of a
 * concrete template id.
 */
type CreationMode = 'template' | 'scratch'

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
  const [mode, setMode] = useState<CreationMode>('template')
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSummary | null>(null)
  const [agentId, setAgentId] = useState('')
  const [displayName, setDisplayName] = useState('')
  // AA-3 scratch-mode form fields. Kept top-level so a back-and-
  // forth between Step 1 and Step 2 preserves whatever the user has
  // already typed (the template-mode pair is preserved the same way).
  const [scratchDescription, setScratchDescription] = useState('')
  const [scratchModel, setScratchModel] = useState<string>('')
  const [scratchThemeColor, setScratchThemeColor] = useState<string>('')
  const [scratchSystemPrompt, setScratchSystemPrompt] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Track which agents already exist so the corresponding template
  // cards can be disabled (AA-1). Fetched once on mount; the page is
  // short-lived so we accept stale data over the wire-up cost of a
  // WS subscription here. The post-create navigation back to /agents
  // refetches via the global agents list.
  const [existingAgentIds, setExistingAgentIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    kbFetch('/api/agents')
      .then((r) => (r.ok ? r.json() : []))
      .then((agents: Array<{ id: string }>) => {
        if (!cancelled && Array.isArray(agents)) {
          setExistingAgentIds(new Set(agents.map((a) => a.id)))
        }
      })
      .catch(() => {
        // Non-fatal: with an empty set every template is enabled,
        // and the API will still 409 on a real conflict.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Select a template
  const handleSelectTemplate = useCallback((template: TemplateSummary) => {
    setMode('template')
    setSelectedTemplate(template)
    // Generate a default agentId from the template name
    setAgentId(template.id)
    setDisplayName('')
    setCreateError(null)
    setStep('configure')
  }, [])

  // AA-3: jump straight to the scratch configure step. We blank the
  // template-mode buffers so a stale id from a half-completed
  // template flow does not leak into the new file's `name`.
  const handleSelectScratch = useCallback(() => {
    setMode('scratch')
    setSelectedTemplate(null)
    setAgentId('')
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
      return { valid: false, message: t('agent.create.validation.idPattern') }
    }
    return { valid: true, message: '' }
  }, [agentId])

  // Create agent — branches on `mode` so the same Create button
  // dispatches against the template path or the scratch path.
  const handleCreate = useCallback(async () => {
    if (!idValidation.valid) return

    setIsCreating(true)
    setCreateError(null)

    try {
      let res: Response
      if (mode === 'template') {
        if (!selectedTemplate) return
        res = await kbFetch('/api/agents/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            templateId: selectedTemplate.id,
            agentId,
            displayName: displayName || undefined,
            // Pass the active UI locale so the server picks the
            // matching template variant (e.g. `kovito-concierge.en.md`
            // for English users instead of the Japanese default).
            locale: getLocale(),
          }),
        })
      } else {
        // Scratch mode validation — the server re-validates so the
        // failure surface stays the same, but a client-side guard
        // gives the operator immediate feedback before a round-trip.
        if (
          displayName.trim().length === 0 ||
          scratchDescription.trim().length === 0 ||
          scratchSystemPrompt.trim().length === 0
        ) {
          throw new Error(t('agent.create.scratch.error.fieldsRequired'))
        }
        res = await kbFetch('/api/agents/create-scratch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            displayName,
            description: scratchDescription,
            systemPrompt: scratchSystemPrompt,
            model: scratchModel || undefined,
            themeColor: scratchThemeColor || undefined,
          }),
        })
      }

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
  }, [
    mode,
    selectedTemplate,
    agentId,
    displayName,
    idValidation.valid,
    scratchDescription,
    scratchModel,
    scratchThemeColor,
    scratchSystemPrompt,
    navigate,
  ])

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 text-sm text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors mb-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {step === 'configure' ? t('agent.create.button.backToTemplate') : t('agent.create.button.backToList')}
        </button>
        <h2 className="text-lg font-semibold text-[var(--text-secondary)]">
          {t('agent.create.title')}
        </h2>
        <p className="text-sm text-[var(--text-dim)] mt-1">
          {step === 'select-template'
            ? t('agent.create.step.selectTemplate')
            : t('agent.create.step.configure')}
        </p>
      </div>

      {/* Step 1: Select template (or pick "from scratch") */}
      {step === 'select-template' && (
        <TemplateSelector
          templates={templates}
          isLoading={isLoading}
          error={fetchError}
          existingAgentIds={existingAgentIds}
          onSelect={handleSelectTemplate}
          onSelectScratch={handleSelectScratch}
        />
      )}

      {/* Step 2 (template mode): Configure and create */}
      {step === 'configure' && mode === 'template' && selectedTemplate && (
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

      {/* Step 2 (scratch mode, AA-3): full from-scratch form */}
      {step === 'configure' && mode === 'scratch' && (
        <ScratchConfigureStep
          agentId={agentId}
          displayName={displayName}
          description={scratchDescription}
          model={scratchModel}
          themeColor={scratchThemeColor}
          systemPrompt={scratchSystemPrompt}
          idValidation={idValidation}
          isCreating={isCreating}
          createError={createError}
          onAgentIdChange={setAgentId}
          onDisplayNameChange={setDisplayName}
          onDescriptionChange={setScratchDescription}
          onModelChange={setScratchModel}
          onThemeColorChange={setScratchThemeColor}
          onSystemPromptChange={setScratchSystemPrompt}
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
  /** Agents already present on disk — their templates are disabled (AA-1). */
  existingAgentIds: Set<string>
  onSelect: (template: TemplateSummary) => void
  /** AA-3: enter the from-scratch configure flow. */
  onSelectScratch: () => void
}

function TemplateSelector({ templates, isLoading, error, existingAgentIds, onSelect, onSelectScratch }: TemplateSelectorProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-[var(--text-dim)]">{t('agent.create.template.loading')}</div>
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
        <p className="text-sm text-[var(--text-dim)]">{t('agent.create.template.empty')}</p>
      </div>
    )
  }

  return (
    <div data-testid="agent-template-selector" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* AA-3: scratch / "blank slate" card. Sits at the head of the
          grid so power users land on it without scrolling past the
          template list. The visual treatment intentionally mirrors
          the template cards (same padding / radius / hover) so it
          reads as a peer choice rather than a side option. */}
      <button
        key="__scratch__"
        type="button"
        data-testid="agent-template-scratch"
        onClick={onSelectScratch}
        className="
          text-left bg-[var(--bg-elevated)] border border-dashed border-[var(--border)] rounded-xl p-5
          transition-all duration-200 group
          hover:bg-[var(--bg-hover)] hover:border-[var(--accent-border)]
        "
      >
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] group-hover:text-[var(--accent-text)] transition-colors">
            {t('agent.create.scratch.title')}
          </h3>
          <span className="text-[10px] text-[var(--text-faint)] bg-[var(--bg-surface)] px-2 py-0.5 rounded-full">
            {t('agent.create.scratch.badge')}
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] line-clamp-3 leading-relaxed">
          {t('agent.create.scratch.description')}
        </p>
        <div className="mt-3 flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('agent.create.scratch.hint')}
        </div>
      </button>

      {templates.map((template) => {
        const alreadyExists = existingAgentIds.has(template.id)
        return (
          <button
            key={template.id}
            data-testid={`agent-template-${template.id}`}
            onClick={() => !alreadyExists && onSelect(template)}
            disabled={alreadyExists}
            title={alreadyExists ? t('agent.create.template.alreadyExists') : undefined}
            className={`
              text-left bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl p-5
              transition-all duration-200 group
              ${alreadyExists
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-[var(--bg-hover)] hover:border-[var(--accent-border)]'}
            `}
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
              {alreadyExists && (
                <span className="ml-2 text-[var(--text-muted)]">
                  · {t('agent.create.template.alreadyExists.short')}
                </span>
              )}
            </div>
          </button>
        )
      })}
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
      {/* Template info — show the avatar that ships with the
          template so the user has a visual confirmation of who they
          are about to create (AA-4). The avatar resolver picks up
          public/avatars/default/<templateId>.svg automatically. */}
      <div className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-faint)]">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-xs text-[var(--text-dim)]">{t('agent.create.templateLabel')}</span>
        </div>
        <div className="flex items-center gap-3">
          <AgentAvatar
            name={template.name}
            color="#a4a8c0"
            size={40}
            avatar={`default/${template.id}.svg`}
            agentId={template.id}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-secondary)] truncate">{template.name}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">{template.description}</p>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="space-y-4">
        {/* Agent ID */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.create.field.agentId')} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            data-testid="agent-id-input"
            value={agentId}
            onChange={(e) => onAgentIdChange(e.target.value)}
            placeholder="my-agent"
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          />
          {idValidation.message && (
            <p className="text-xs text-red-400 mt-1">{idValidation.message}</p>
          )}
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.create.field.agentIdHint')}: <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">.claude/agents/{agentId || '...'}.md</code>
          </p>
        </div>

        {/* Display name */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.create.field.displayName')} <span className="text-[var(--text-faint)]">({t('agent.create.field.optional')})</span>
          </label>
          <input
            type="text"
            data-testid="agent-display-name-input"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder={template.name}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          />
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.create.field.displayNameHint')}
          </p>
        </div>
      </div>

      {/* Error display */}
      {createError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mt-4">
          <p className="text-sm text-red-400">{createError}</p>
        </div>
      )}

      {/* Create button */}
      <div className="mt-6 flex items-center gap-3">
        <button
          data-testid="agent-create-button"
          onClick={onCreate}
          disabled={!idValidation.valid || isCreating}
          className={`
            px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-200
            ${idValidation.valid && !isCreating
              ? 'bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90'
              : 'bg-[var(--bg-surface)] text-[var(--text-faint)] cursor-not-allowed'}
          `}
        >
          {isCreating ? t('agent.create.status.creating') : t('agent.create.button.create')}
        </button>
        <p className="text-[10px] text-[var(--text-faint)]">
          {t('agent.create.launchHint.prefix')}{' '}
          <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">claude --agent {agentId || '...'}</code>
          {' '}{t('agent.create.launchHint.suffix')}
        </p>
      </div>
    </div>
  )
}

// --- AA-3: from-scratch configure step ---

/**
 * 8 preset theme colors (mirrors AD-3's `StructuredFieldEditor` grid
 * for visual consistency between create and edit). The native color
 * picker remains available below the chips for users who want a
 * non-preset hex.
 */
const THEME_COLOR_PRESETS = [
  '#a855f7', // purple-500
  '#3b82f6', // blue-500
  '#06b6d4', // cyan-500
  '#22c55e', // green-500
  '#eab308', // yellow-500
  '#f97316', // orange-500
  '#ef4444', // red-500
  '#ec4899', // pink-500
]

const MODEL_OPTIONS = ['default', 'sonnet', 'opus', 'haiku'] as const

interface ScratchConfigureStepProps {
  agentId: string
  displayName: string
  description: string
  model: string
  themeColor: string
  systemPrompt: string
  idValidation: { valid: boolean; message: string }
  isCreating: boolean
  createError: string | null
  onAgentIdChange: (value: string) => void
  onDisplayNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onModelChange: (value: string) => void
  onThemeColorChange: (value: string) => void
  onSystemPromptChange: (value: string) => void
  onCreate: () => void
}

/**
 * Edits the same metadata as `StructuredFieldEditor` (AD-3) plus a
 * required `systemPrompt` body. We deliberately do NOT reuse that
 * editor here — its API is bound to per-section save semantics that
 * do not apply on create — but the control set / labels follow the
 * same vocabulary so the create-then-edit round-trip feels
 * continuous.
 */
function ScratchConfigureStep({
  agentId,
  displayName,
  description,
  model,
  themeColor,
  systemPrompt,
  idValidation,
  isCreating,
  createError,
  onAgentIdChange,
  onDisplayNameChange,
  onDescriptionChange,
  onModelChange,
  onThemeColorChange,
  onSystemPromptChange,
  onCreate,
}: ScratchConfigureStepProps) {
  const formReady =
    idValidation.valid &&
    displayName.trim().length > 0 &&
    description.trim().length > 0 &&
    systemPrompt.trim().length > 0
  return (
    <div className="max-w-2xl">
      {/* Header chip mirroring the template card so the user
          always sees what mode they are in. The scratch icon is a
          plus-sign disc to match the Step 1 card. */}
      <div className="bg-[var(--bg-elevated)] border border-dashed border-[var(--border)] rounded-lg p-4 mb-6 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-faint)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-secondary)] truncate">
            {t('agent.create.scratch.title')}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">
            {t('agent.create.scratch.description')}
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {/* Agent ID */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.create.field.agentId')} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            data-testid="agent-id-input"
            value={agentId}
            onChange={(e) => onAgentIdChange(e.target.value)}
            placeholder="my-agent"
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          />
          {idValidation.message && (
            <p className="text-xs text-red-400 mt-1">{idValidation.message}</p>
          )}
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.create.field.agentIdHint')}: <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">.claude/agents/{agentId || '...'}.md</code>
          </p>
        </div>

        {/* Display name */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.create.field.displayName')} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            data-testid="agent-display-name-input"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder={t('agent.create.scratch.field.displayName.placeholder')}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.field.description.label')} <span className="text-red-400">*</span>
          </label>
          <textarea
            data-testid="agent-description-input"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder={t('agent.field.description.placeholder')}
            rows={2}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y"
          />
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.field.description.description')}
          </p>
        </div>

        {/* Model */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.field.model.label')}
          </label>
          <select
            data-testid="agent-model-select"
            value={model || 'default'}
            onChange={(e) => onModelChange(e.target.value === 'default' ? '' : e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.field.model.description')}
          </p>
        </div>

        {/* Theme color */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.field.themeColor.label')}
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {THEME_COLOR_PRESETS.map((preset) => {
              const isActive = themeColor.toLowerCase() === preset.toLowerCase()
              return (
                <button
                  key={preset}
                  type="button"
                  data-testid={`agent-theme-color-${preset.slice(1)}`}
                  onClick={() => onThemeColorChange(isActive ? '' : preset)}
                  className={`
                    w-7 h-7 rounded-full border-2 transition-transform
                    ${isActive ? 'scale-110 border-white/80' : 'border-transparent hover:scale-105'}
                  `}
                  style={{ backgroundColor: preset }}
                  aria-pressed={isActive}
                  aria-label={preset}
                />
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              data-testid="agent-theme-color-picker"
              value={themeColor || '#a4a8c0'}
              onChange={(e) => onThemeColorChange(e.target.value)}
              className="w-10 h-9 p-0 rounded border border-[var(--border)] bg-[var(--bg-surface)] cursor-pointer"
            />
            <input
              type="text"
              data-testid="agent-theme-color-hex"
              value={themeColor}
              onChange={(e) => onThemeColorChange(e.target.value)}
              placeholder="#a855f7"
              className="flex-1 px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors font-mono"
            />
            {themeColor && (
              <button
                type="button"
                onClick={() => onThemeColorChange('')}
                className="px-2 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors"
              >
                {t('common.clear')}
              </button>
            )}
          </div>
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.field.themeColor.description')}
          </p>
        </div>

        {/* System prompt */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            {t('agent.create.scratch.field.systemPrompt.label')} <span className="text-red-400">*</span>
          </label>
          <textarea
            data-testid="agent-system-prompt-input"
            value={systemPrompt}
            onChange={(e) => onSystemPromptChange(e.target.value)}
            placeholder={t('agent.create.scratch.field.systemPrompt.placeholder')}
            rows={10}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors font-mono resize-y"
          />
          <p className="text-[10px] text-[var(--text-faint)] mt-1">
            {t('agent.create.scratch.field.systemPrompt.hint')}
          </p>
        </div>
      </div>

      {createError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mt-4">
          <p className="text-sm text-red-400">{createError}</p>
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          data-testid="agent-create-button"
          onClick={onCreate}
          disabled={!formReady || isCreating}
          className={`
            px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-200
            ${formReady && !isCreating
              ? 'bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90'
              : 'bg-[var(--bg-surface)] text-[var(--text-faint)] cursor-not-allowed'}
          `}
        >
          {isCreating ? t('agent.create.status.creating') : t('agent.create.button.create')}
        </button>
        <p className="text-[10px] text-[var(--text-faint)]">
          {t('agent.create.launchHint.prefix')}{' '}
          <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">claude --agent {agentId || '...'}</code>
          {' '}{t('agent.create.launchHint.suffix')}
        </p>
      </div>
    </div>
  )
}
