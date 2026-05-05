/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
  TrustPromptKind,
} from '../../shared/ws-events'
import type { TrustPromptItem } from '../hooks/useIPC'
import { t } from '../i18n'
import { createLogger } from '../lib/logger'

const log = createLogger('trust-prompt-modal')

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

// Resolve the localized label every render. Building this as a
// module-level const evaluated `t()` once at module load, which
// captured whatever locale was persisted in localStorage at that
// instant — subsequent locale changes (e.g. via the onboarding
// wizard) left the dictionary frozen, producing mixed-language
// titles where the prefix used the new locale and the suffix
// kept the locale that was active when the module first loaded.
function resolveKindLabel(kind: TrustPromptKind): string {
  switch (kind) {
    case 'folder-trust':
      return t('trust.kind.folderTrust')
    case 'write':
      return t('trust.kind.write')
    case 'edit':
      return t('trust.kind.edit')
    case 'read':
      return t('trust.kind.read')
    case 'bash':
      return t('trust.kind.bash')
    case 'sandbox-network':
      return t('trust.kind.sandboxNetwork')
    case 'other':
      return t('trust.kind.other')
    default:
      return kind
  }
}

const KIND_ICON: Record<TrustPromptKind, string> = {
  'folder-trust': '📁',
  write: '📝',
  edit: '✏️',
  read: '📖',
  bash: '⚡',
  'sandbox-network': '🌐',
  other: '❓',
}

/**
 * Quick-key buttons surfaced on every trust-prompt modal (spec v1.2
 * §5-3-1 / §5-3-1a). The first five entries are the canonical "special
 * keys" the spec mandates everywhere — Esc / Tab / Ctrl+E / Ctrl+C /
 * Enter — followed by short auxiliary buttons that the fallback UX has
 * relied on historically (single-character answers Claude Code may
 * accept for legacy prompts).
 */
const QUICK_KEYS = [
  { label: 'Enter', keys: 'Enter' },
  { label: 'Esc', keys: 'Escape' },
  { label: 'Tab', keys: 'Tab' },
  { label: 'Ctrl+E', keys: 'C-e' },
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
      log.warn('Failed to copy to clipboard')
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
        onRawKeys={onRawKeys}
        rawKeysInput={rawKeysInput}
        onRawKeysInputChange={setRawKeysInput}
        onSubmitRawKeys={handleRawKeysSubmit}
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
            <span data-testid="trust-prompt-kind-label">{t('trust.fallback.title')}</span>
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
            <span
              className="px-2 py-1 rounded-md border"
              style={{
                background: 'var(--warning-bg)',
                borderColor: 'var(--warning-border)',
                color: 'var(--warning-text)',
              }}
            >
              {t('trust.fallback.badge')}
            </span>
          </div>

          {/* Warning banner */}
          <div
            className="p-3 rounded-lg border text-sm flex items-start gap-2"
            style={{
              background: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning-text)',
            }}
          >
            <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
            <div>
              <div className="font-semibold mb-0.5">{t('trust.fallback.warning.title')}</div>
              <div className="text-xs opacity-90">
                {t('trust.fallback.warning.description')}
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
              {t('trust.fallback.quickKeys')}
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
              {t('trust.fallback.freeInput')}
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
                placeholder={t('trust.fallback.freeInputPlaceholder')}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border)] placeholder-[var(--text-dim)] focus:outline-none focus:border-[var(--accent-border)]"
                maxLength={1024}
              />
              <button
                onClick={handleRawKeysSubmit}
                disabled={!rawKeysInput.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('trust.fallback.button.send')}
              </button>
            </div>
          </div>

          {/* tmux attach command copy */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3">
            <div className="text-xs text-[var(--text-dim)] mb-2">
              {t('trust.tmux.label')}
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-2 py-1 text-xs font-mono text-[var(--text-tertiary)] bg-black/20 rounded">
                tmux attach -t &quot;{windowName}&quot;
              </code>
              <button
                onClick={() => handleCopyTmuxCommand(windowName)}
                className="px-3 py-1 rounded-md text-xs font-medium text-[var(--text-dim)] border border-[var(--border)] hover:text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
              >
                {copied ? t('trust.tmux.copied') : t('trust.tmux.copy')}
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
  onRawKeys,
  rawKeysInput,
  onRawKeysInputChange,
  onSubmitRawKeys,
  onDismiss,
}: {
  event: TrustPromptDetectedPayload
  showRawBuffer: boolean
  onToggleRawBuffer: () => void
  onChoice: (choiceId: string) => void
  onRawKeys: (rawKeys: string) => void
  rawKeysInput: string
  onRawKeysInputChange: (value: string) => void
  onSubmitRawKeys: () => void
  onDismiss: () => void
}) {
  const kindLabel = resolveKindLabel(event.kind)
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
            <span data-testid="trust-prompt-kind-label">{t('trust.detected.title')}: {kindLabel}</span>
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
            <div
              className="p-3 rounded-lg border text-sm flex items-start gap-2"
              style={{
                background: 'var(--warning-bg)',
                borderColor: 'var(--warning-border)',
                color: 'var(--warning-text)',
              }}
            >
              <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
              <div>
                <div className="font-semibold mb-0.5">{t('trust.detected.degenerate.title')}</div>
                <div className="text-xs opacity-90">
                  {t('trust.detected.degenerate.description')}
                </div>
              </div>
            </div>
          )}

          {/* Extracted details */}
          {detailEntries.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden">
              <div className="px-4 py-2 text-xs font-semibold text-[var(--text-dim)] border-b border-[var(--border)]">
                {t('trust.detected.extractedInfo')}
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

          {/* Custom answer section (spec v1.2 §5-3-1a — always present
              on detected dialogs, not only on the fallback UX). Lets
              the user send a free-form raw-keys response or a special
              key (Esc / Tab / Ctrl+E / Ctrl+C / Enter) when none of the
              dynamically extracted choices fit. */}
          <details
            className="rounded-lg border border-[var(--border)] overflow-hidden"
            data-testid="trust-prompt-custom-answer"
          >
            <summary className="px-4 py-2 cursor-pointer text-xs font-semibold text-[var(--text-dim)] hover:text-[var(--text-tertiary)] bg-[var(--bg-surface)] transition-colors select-none">
              {t('trust.common.customAnswer.title')}
            </summary>
            <div className="px-4 py-3 space-y-3">
              {/* Quick key buttons */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-[var(--text-dim)]">
                  {t('trust.common.quickKeys')}
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

              {/* Free-form raw-keys input */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-[var(--text-dim)]">
                  {t('trust.common.freeInput')}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={rawKeysInput}
                    onChange={(e) => onRawKeysInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        onSubmitRawKeys()
                      }
                    }}
                    placeholder={t('trust.common.freeInputPlaceholder')}
                    className="flex-1 px-3 py-2 rounded-lg text-sm font-mono bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border)] placeholder-[var(--text-dim)] focus:outline-none focus:border-[var(--accent-border)]"
                    maxLength={1024}
                    data-testid="trust-prompt-detected-free-input"
                  />
                  <button
                    onClick={onSubmitRawKeys}
                    disabled={!rawKeysInput.trim()}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid="trust-prompt-detected-free-input-send"
                  >
                    {t('trust.common.button.send')}
                  </button>
                </div>
              </div>
            </div>
          </details>
        </div>

        {/* Choice buttons (footer) */}
        <div className="px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-surface)] flex flex-col-reverse sm:flex-row sm:flex-wrap gap-2 sm:justify-end">
          {event.choices.length === 0 ? (
            <div className="text-xs text-[var(--text-dim)] self-center">
              {t('trust.detected.noChoices')}
            </div>
          ) : (
            event.choices.map((choice, idx) => {
              // Highlight the first item as primary
              const isPrimary = idx === 0
              const tooltip = choice.fullLabel ?? choice.label
              return (
                <button
                  key={choice.id}
                  data-testid={`trust-prompt-choice-${choice.id}`}
                  onClick={() => onChoice(choice.id)}
                  title={tooltip}
                  aria-label={tooltip}
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
      aria-label={t('common.close')}
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
        <span>{t('trust.rawBuffer.title')}</span>
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
