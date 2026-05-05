/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KbAuthoredSections — render KovitoBoard-authored portions of a
 * user message as collapsible summary chips. The expanded view shows
 * the original section text inside a `<pre>` so the agent-facing
 * payload is faithfully reproducible.
 *
 * Used by `MessageBubble` (sessions screen) and `AmbientSidebar`
 * (right-rail chat). The two surfaces share the same component to
 * keep behavior consistent — only the surrounding density differs.
 */
import { useState } from 'react'
import { t } from '../i18n'
import type { MessageKey } from '../i18n'
import type { KbSection, KbSectionKind } from '../utils/kb-authored-message'

const ICON_BY_KIND: Record<KbSectionKind, string> = {
  preamble: '📋',
  kbcontext: '📍',
  a11y: '♿',
  'exposed-context': '📦',
  selected: '🎯',
  'recipe-install': '🧩',
  'app-create': '🛠️',
  'continue-session': '🔄',
  // SS-3 / Q4: skill activation + generic-bucket sentinel kinds.
  // The skill icon (🛠 prefix variant) communicates "tool config"
  // while staying visually distinct from app-create's wrench;
  // 'other' uses a neutral memo icon so unrecognized future types
  // still surface visibly.
  'skill-base-dir': '🧰',
  other: '📝',
}

const LABEL_KEY_BY_KIND: Record<KbSectionKind, MessageKey> = {
  preamble: 'kbAuthored.section.preamble',
  kbcontext: 'kbAuthored.section.kbcontext',
  a11y: 'kbAuthored.section.a11y',
  'exposed-context': 'kbAuthored.section.exposedContext',
  selected: 'kbAuthored.section.selected',
  'recipe-install': 'kbAuthored.section.recipeInstall',
  'app-create': 'kbAuthored.section.appCreate',
  'continue-session': 'kbAuthored.section.continueSession',
  'skill-base-dir': 'kbAuthored.section.skillBaseDir',
  other: 'kbAuthored.section.other',
}

interface KbAuthoredSectionsProps {
  sections: KbSection[]
  /** Compact density for the ambient sidebar (smaller fonts, tighter padding). */
  compact?: boolean
}

/**
 * Build the chip's display label. For recipe-install the recipe name
 * is interpolated into the i18n template (`{name}` placeholder); for
 * continue-session the short session ID goes into `{sessionId}`.
 */
function formatLabel(section: KbSection): string {
  const base = t(LABEL_KEY_BY_KIND[section.kind])
  if (section.kind === 'recipe-install' && section.label) {
    return base.replace('{name}', section.label)
  }
  if (section.kind === 'continue-session' && section.label) {
    return base.replace('{sessionId}', section.label)
  }
  return base
}

export function KbAuthoredSections({ sections, compact = false }: KbAuthoredSectionsProps) {
  if (sections.length === 0) return null
  return (
    <div
      className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-1.5 mb-1'}
      data-testid="kb-authored-sections"
    >
      {sections.map((section, idx) => (
        <KbAuthoredChip
          key={`${section.kind}-${idx}`}
          section={section}
          compact={compact}
        />
      ))}
    </div>
  )
}

interface KbAuthoredChipProps {
  section: KbSection
  compact: boolean
}

function KbAuthoredChip({ section, compact }: KbAuthoredChipProps) {
  const [expanded, setExpanded] = useState(false)
  const icon = ICON_BY_KIND[section.kind]
  const label = formatLabel(section)
  const buttonText = expanded
    ? t('kbAuthored.button.collapse')
    : t('kbAuthored.button.expand')

  return (
    <div
      data-testid={`kb-authored-chip-${section.kind}`}
      data-expanded={expanded}
      className={
        compact
          ? 'rounded border border-[var(--border)] bg-[var(--bg-base)]/40 text-[10px]'
          : 'rounded-md border border-[var(--border)] bg-[var(--bg-base)]/60 text-[11px]'
      }
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={
          compact
            ? 'w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--bg-hover)] transition-colors'
            : 'w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors'
        }
      >
        <span aria-hidden="true">{icon}</span>
        <span className="flex-1 truncate text-[var(--text-secondary)]">{label}</span>
        <span className="text-[var(--text-dim)]">{buttonText}</span>
      </button>
      {expanded && (
        <pre
          data-testid={`kb-authored-chip-${section.kind}-content`}
          className={
            compact
              ? 'border-t border-[var(--border)] px-2 py-1.5 whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--text-tertiary)] max-h-60 overflow-y-auto'
              : 'border-t border-[var(--border)] px-3 py-2 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text-tertiary)] max-h-80 overflow-y-auto'
          }
        >
          {section.content}
        </pre>
      )}
    </div>
  )
}
