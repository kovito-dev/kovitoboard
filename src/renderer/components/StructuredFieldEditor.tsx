/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Structured Field Editor
 *
 * UI for individually editing marker-delimited sections
 * (personality, tone sample, extra instructions) within agent definition files.
 */

import { useState, useCallback } from 'react'
import { t } from '../i18n'

/** Data for editable sections */
export interface SectionData {
  displayName: string
  /** Q3 / AD-3: agent description (frontmatter `description`). */
  description: string
  /** Q3 / AD-3: model dist-tag ('default' | 'sonnet' | 'opus' | 'haiku'). */
  model: string
  /** Q3 / AD-3: hex theme color (e.g. '#a855f7'). Empty clears. */
  themeColor: string
  personality: string
  toneSample: string
  extraInstructions: string
}

/**
 * Q3 / AD-3 model option set. Surfaced as a select so the user does
 * not have to hand-type the dist-tag (and can't accidentally save a
 * typo like `sonet`).
 */
const MODEL_OPTIONS = ['default', 'sonnet', 'opus', 'haiku'] as const

/**
 * Q3 / AD-3 theme color presets. The 8 colors mirror the developer
 * proposal so users get a one-click palette without discovering hex.
 * Custom hex is still accepted via the inline `<input type="color">`.
 */
const THEME_COLOR_PRESETS = [
  '#6b7280', // neutral
  '#ef4444', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#ec4899', // pink
] as const

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
  const [description, setDescription] = useState(initial.description)
  const [model, setModel] = useState(initial.model || 'default')
  const [themeColor, setThemeColor] = useState(initial.themeColor)
  const [personality, setPersonality] = useState(initial.personality)
  const [toneSample, setToneSample] = useState(initial.toneSample)
  const [extraInstructions, setExtraInstructions] = useState(initial.extraInstructions)

  // Check if there are changes
  const hasChanges =
    displayName !== initial.displayName ||
    description !== initial.description ||
    model !== initial.model ||
    themeColor !== initial.themeColor ||
    personality !== initial.personality ||
    toneSample !== initial.toneSample ||
    extraInstructions !== initial.extraInstructions

  const handleSave = useCallback(() => {
    onSave({
      displayName,
      description,
      model,
      themeColor,
      personality,
      toneSample,
      extraInstructions,
    })
  }, [displayName, description, model, themeColor, personality, toneSample, extraInstructions, onSave])

  return (
    <div className="space-y-5">
      {/* Display name -- editable regardless of marker presence */}
      <FieldSection
        label={t('agent.field.displayName.label')}
        description={t('agent.field.displayName.description')}
      >
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('agent.field.displayName.placeholder')}
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
        />
      </FieldSection>

      {/* Q3 / AD-3: description, model, themeColor — frontmatter
          fields editable independently of the marker block. */}
      <FieldSection
        label={t('agent.field.description.label')}
        description={t('agent.field.description.description')}
      >
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder={t('agent.field.description.placeholder')}
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y"
        />
      </FieldSection>

      <FieldSection
        label={t('agent.field.model.label')}
        description={t('agent.field.model.description')}
      >
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
          data-testid="agent-field-model"
        >
          {MODEL_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </FieldSection>

      <FieldSection
        label={t('agent.field.themeColor.label')}
        description={t('agent.field.themeColor.description')}
      >
        <div className="flex items-center gap-2 flex-wrap">
          {/* Preset chips: clicking a preset writes its hex into the
              themeColor state so the input reflects the choice. */}
          {THEME_COLOR_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset}
              onClick={() => setThemeColor(preset)}
              aria-label={`Set theme color to ${preset}`}
              className={`w-7 h-7 rounded-full border-2 transition-all ${
                themeColor.toLowerCase() === preset.toLowerCase()
                  ? 'border-[var(--accent-border)] scale-110'
                  : 'border-[var(--border)] hover:scale-105'
              }`}
              style={{ background: preset }}
            />
          ))}
          <input
            type="color"
            value={themeColor || '#6b7280'}
            onChange={(e) => setThemeColor(e.target.value)}
            className="w-10 h-8 rounded cursor-pointer bg-transparent border border-[var(--border)]"
            data-testid="agent-field-themeColor-picker"
          />
          <input
            type="text"
            value={themeColor}
            onChange={(e) => setThemeColor(e.target.value)}
            placeholder="#a855f7"
            maxLength={7}
            className="px-2 py-1.5 w-24 text-xs font-mono rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors"
            data-testid="agent-field-themeColor-text"
          />
          <button
            type="button"
            onClick={() => setThemeColor('')}
            className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text-tertiary)] underline"
          >
            {t('agent.field.themeColor.clear')}
          </button>
        </div>
      </FieldSection>

      {/* Warning when markers are absent */}
      {!hasMarkers && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-[var(--warning-bg)] border border-[var(--warning-border)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--warning-text)] shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <p className="text-sm text-[var(--warning-text)] font-medium">{t('agent.field.noMarkers.title')}</p>
            <p className="text-xs text-[var(--text-dim)] mt-0.5">
              {t('agent.field.noMarkers.description')}
            </p>
          </div>
        </div>
      )}

      {/* Structured fields -- editable only when markers are present */}
      <FieldSection
        label={t('agent.field.personality.label')}
        description={t('agent.field.personality.description')}
        disabled={!hasMarkers}
      >
        <textarea
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          disabled={!hasMarkers}
          rows={5}
          placeholder={t('agent.field.personality.placeholder')}
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed font-mono"
        />
      </FieldSection>

      <FieldSection
        label={t('agent.field.toneSample.label')}
        description={t('agent.field.toneSample.description')}
        disabled={!hasMarkers}
      >
        <textarea
          value={toneSample}
          onChange={(e) => setToneSample(e.target.value)}
          disabled={!hasMarkers}
          rows={5}
          placeholder={t('agent.field.toneSample.placeholder')}
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed font-mono"
        />
      </FieldSection>

      <FieldSection
        label={t('agent.field.extraInstructions.label')}
        description={t('agent.field.extraInstructions.description')}
        disabled={!hasMarkers}
      >
        <textarea
          value={extraInstructions}
          onChange={(e) => setExtraInstructions(e.target.value)}
          disabled={!hasMarkers}
          rows={4}
          placeholder={t('agent.field.extraInstructions.placeholder')}
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
          {isSaving ? t('agent.field.status.saving') : t('common.save')}
        </button>
        <button
          onClick={onCancel}
          disabled={isSaving}
          className="px-4 py-2.5 text-sm text-[var(--text-dim)] hover:text-[var(--text-tertiary)] transition-colors"
        >
          {t('common.cancel')}
        </button>
        {hasChanges && !isSaving && (
          <span className="text-[10px] text-[var(--text-faint)]">{t('agent.field.hint.unsaved')}</span>
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
