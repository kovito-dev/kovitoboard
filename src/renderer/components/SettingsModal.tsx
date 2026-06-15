/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect, useMemo } from 'react'
import { t } from '../i18n'
import { createLogger } from '../lib/logger'
import { useSidebarSettings } from '../hooks/useSidebarSettings'
import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'
import { UserAvatarUpload } from './UserAvatarUpload'
import { SettingsWorkRoots } from './SettingsWorkRoots'
import { kbFetch } from '../lib/kbFetch'

const log = createLogger('SettingsModal')

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

// --- Type definitions ---

interface BasicSettings {
  projectName: string
  description: string
  concept: string
  userName: string
  /** Q11 / SM-4 user avatar relative path (`user/avatar.png`, etc.). Empty string when unset. */
  userAvatar: string
  language: string
  agents: { id: string; name: string; role: string; employeeId?: string }[]
}

interface SkillInfo {
  name: string
  description: string
  category: 'operation' | 'procedure' | 'knowledge'
  invocation: string
}

interface HookInfo {
  event: string
  type: string
  command: string
}

interface IntegrationInfo {
  name: string
  type: string
  status: string
}

interface RuleInfo {
  name: string
  content: string
}

type TabId =
  | 'basic'
  | 'workRoots'
  | 'skills'
  | 'automations'
  | 'integrations'
  | 'rules'
  | 'ambientSidebar'

// Built at module evaluation. The locale is restored from
// localStorage by `i18n/readPersistedLocale()` (OSS fallback: en).
// v0.2.1 BL-2026-167: `workRoots` is additively inserted right after
// `basic` (judgement doc v1.1 §2.1 case A / §2.2 case B-1) so the
// allow-list management surface lives alongside the other top-level
// configuration tabs instead of as a standalone side-nav item.
const TABS: { id: TabId; label: string }[] = [
  { id: 'basic', label: t('setting.tab.basic') },
  { id: 'workRoots', label: t('setting.tab.workRoots') },
  { id: 'skills', label: t('setting.tab.skills') },
  { id: 'automations', label: t('setting.tab.automations') },
  { id: 'integrations', label: t('setting.tab.integrations') },
  { id: 'rules', label: t('setting.tab.rules') },
  { id: 'ambientSidebar', label: t('setting.tab.ambientSidebar') },
]

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('basic')

  // Close on ESC key
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal body */}
      <div className="relative w-full max-w-4xl mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden h-full md:h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-secondary)] flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t('setting.title')}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-0 px-3 md:px-6 border-b border-[var(--border)] overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                px-4 py-3 text-sm font-medium border-b-2 transition-colors
                ${activeTab === tab.id
                  ? 'border-[var(--accent-border)] text-[var(--accent-text)]'
                  : 'border-transparent text-[var(--text-dim)] hover:text-[var(--text-tertiary)]'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-3 md:p-6">
          {activeTab === 'basic' && <SettingsBasic />}
          {activeTab === 'workRoots' && <SettingsWorkRoots />}
          {activeTab === 'skills' && <SettingsSkills />}
          {activeTab === 'automations' && <SettingsAutomations />}
          {activeTab === 'integrations' && <SettingsIntegrations />}
          {activeTab === 'rules' && <SettingsRules />}
          {activeTab === 'ambientSidebar' && <SettingsAmbientSidebar />}
        </div>
      </div>
    </div>
  )
}

// --- Help icon ---

function HelpTip({ text }: { text: string }) {
  const [show, setShow] = useState(false)

  return (
    <span className="relative inline-block ml-2">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(!show)}
        className="text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>
      {show && (
        // Right-align + cap width so the localized help text (which
        // can run several Japanese characters past the modal edge
        // when emitted on a single nowrap line) wraps inside the
        // dialog. Was: left-1/2 -translate-x-1/2 + whitespace-nowrap,
        // which clipped on the right edge of the viewport.
        <span className="absolute z-10 bottom-full right-0 mb-2 px-3 py-2 text-xs text-[var(--text-tertiary)] bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg shadow-lg w-72 max-w-[80vw] whitespace-normal break-words leading-relaxed">
          {text}
        </span>
      )}
    </span>
  )
}

// --- Basic settings tab ---

interface BasicEditDraft {
  displayName: string
  locale: 'ja' | 'en'
  projectName: string
  projectDescription: string
}

/**
 * Q11 / SM-4: editable basic-settings tab. Replaces the read-only
 * "ask the concierge" affordance with an inline form so users can
 * change the four spec-approved fields without dispatching an
 * agent. The fields persist via PUT /api/settings/basic; on success
 * the page locale and session-log status are updated immediately.
 *
 * project.path is intentionally not editable here (architect §6.9 —
 * project switching is a separate UI on the v0.1.1+ backlog).
 */
function SettingsBasic() {
  // `data` keeps the original BasicSettings payload around for any
  // legacy consumers; the editable form drives off `baseline` (last
  // saved values in BasicEditDraft shape) vs `draft` (current input).
  // Splitting them avoids needing to round-trip through the legacy
  // `language: 'Japanese' | 'English'` representation when computing
  // dirtiness or when we save (the API wants `locale: 'ja' | 'en'`).
  const [data, setData] = useState<BasicSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [baseline, setBaseline] = useState<BasicEditDraft | null>(null)
  const [draft, setDraft] = useState<BasicEditDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)
  // Avatar lives outside the BasicEditDraft because it is updated
  // via a dedicated multipart endpoint, not the JSON PUT below.
  // Each successful upload / delete bumps the cache-buster suffix
  // so the <img> in the preview reloads even when the relative
  // path does not change (the server stores avatar.png + avatar.svg
  // under the same dir; round-trips reuse the path).
  const [userAvatar, setUserAvatar] = useState<string>('')
  const [avatarCacheBust, setAvatarCacheBust] = useState<number>(0)

  // Refetch /api/settings/basic to pick up the latest userAvatar
  // value (the field is owned by /api/settings/user/avatar but
  // surfaced through the same read endpoint so the modal only
  // needs one round-trip to populate the preview on open).
  const reloadAvatar = () => {
    kbFetch('/api/settings/basic')
      .then((r) => r.json())
      .then((settings: BasicSettings) => {
        setUserAvatar(settings.userAvatar ?? '')
        setAvatarCacheBust(Date.now())
      })
      .catch((err) => {
        log.warn({ err, endpoint: 'settings/basic' }, 'Failed to reload avatar')
      })
  }

  useEffect(() => {
    kbFetch('/api/settings/basic')
      .then((r) => r.json())
      .then((settings: BasicSettings) => {
        setData(settings)
        setUserAvatar(settings.userAvatar ?? '')
        const initial: BasicEditDraft = {
          displayName: settings.userName ?? '',
          locale: settings.language === 'English' ? 'en' : 'ja',
          projectName: settings.projectName ?? '',
          projectDescription: settings.description ?? '',
        }
        setBaseline(initial)
        setDraft(initial)
      })
      .catch((err) => {
        log.warn({ err, endpoint: 'settings/basic' }, 'Failed to load settings')
        setData(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const isDirty = useMemo(() => {
    if (!baseline || !draft) return false
    return (
      draft.displayName !== baseline.displayName ||
      draft.locale !== baseline.locale ||
      draft.projectName !== baseline.projectName ||
      draft.projectDescription !== baseline.projectDescription
    )
  }, [baseline, draft])

  const updateDraft = (patch: Partial<BasicEditDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
    setSaveStatus('idle')
    setGlobalError(null)
  }

  const handleReset = () => {
    if (!baseline) return
    setDraft(baseline)
    setFieldErrors({})
    setGlobalError(null)
    setSaveStatus('idle')
  }

  const handleSave = async () => {
    if (!draft) return
    setSaving(true)
    setSaveStatus('idle')
    setFieldErrors({})
    setGlobalError(null)
    try {
      const res = await kbFetch('/api/settings/basic', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        if (payload?.fields && typeof payload.fields === 'object') {
          setFieldErrors(payload.fields as Record<string, string>)
        }
        setGlobalError(typeof payload?.error === 'string' ? payload.error : 'save failed')
        setSaveStatus('error')
        return
      }
      // Refresh the baseline so subsequent edits re-compute `isDirty`
      // against the values we just persisted.
      setBaseline(draft)
      setSaveStatus('saved')
      // Apply the locale change to the running UI immediately so
      // copy switches without a reload (mirrors how the onboarding
      // wizard publishes the locale once setup completes).
      try {
        window.localStorage.setItem('kb.locale', draft.locale)
      } catch {
        // best-effort; the next reload picks it up regardless.
      }
    } catch (err) {
      log.warn({ err }, 'Failed to save basic settings')
      setGlobalError(err instanceof Error ? err.message : 'save failed')
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingSpinner />
  if (!data || !draft) return <ErrorMessage message={t('setting.basic.error.loadFailed')} />

  return (
    <div className="space-y-6">
      {/* User avatar (Q11 / SM-4 extension): editable independently of
          the JSON form below — the avatar API is a separate multipart
          endpoint, so dirtiness on the form does not block the avatar
          and vice versa. */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">
          {t('setting.basic.section.userAvatar')}
        </h3>
        <div className="flex items-center gap-4">
          <AgentAvatar
            // userAvatar is the `user/avatar.<ext>` relative path.
            // The cache-buster suffix forces an <img> reload after a
            // successful upload — without it the browser keeps
            // showing the previous file because the URL is identical
            // when the user replaces e.g. one PNG with another.
            avatar={
              userAvatar
                ? avatarCacheBust > 0
                  ? `${userAvatar}?v=${avatarCacheBust}`
                  : userAvatar
                : undefined
            }
            name={data.userName || 'User'}
            // The user surface does not carry a themeColor today; we
            // pass an explicit neutral color so the AgentAvatar
            // resolver does not fall through to its black-on-light
            // fallback. Width matches the chat-bubble preview to
            // give the operator an honest "this is what others see".
            color="#7C3AED"
            size={56}
          />
          <UserAvatarUpload onChanged={reloadAvatar} />
        </div>
      </div>

      {/* Editable basic information form */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">{t('setting.basic.section.info')}</h3>

        <div className="space-y-4">
          <EditableSettingField
            label={t('setting.basic.field.projectName')}
            value={draft.projectName}
            onChange={(v) => updateDraft({ projectName: v })}
            helpText={t('setting.basic.help.projectName')}
            maxLength={100}
            error={fieldErrors.projectName}
            testId="setting-basic-projectName"
          />
          <EditableSettingField
            label={t('setting.basic.field.description')}
            value={draft.projectDescription}
            onChange={(v) => updateDraft({ projectDescription: v })}
            helpText={t('setting.basic.help.description')}
            maxLength={200}
            optional
            error={fieldErrors.projectDescription}
            testId="setting-basic-projectDescription"
          />
          <EditableSettingField
            label={t('setting.basic.field.userName')}
            value={draft.displayName}
            onChange={(v) => updateDraft({ displayName: v })}
            helpText={t('setting.basic.help.userName')}
            maxLength={50}
            error={fieldErrors.displayName}
            testId="setting-basic-displayName"
          />
          <div>
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-xs text-[var(--text-dim)]">
                {t('setting.basic.field.language')}
              </span>
              <HelpTip text={t('setting.basic.help.language')} />
            </div>
            <select
              data-testid="setting-basic-locale"
              value={draft.locale}
              onChange={(e) => updateDraft({ locale: e.target.value as 'ja' | 'en' })}
              className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent-border)]"
            >
              <option value="ja">{t('setting.basic.language.ja')}</option>
              <option value="en">{t('setting.basic.language.en')}</option>
            </select>
            {fieldErrors.locale && (
              <p className="mt-1 text-[11px] text-red-400">{fieldErrors.locale}</p>
            )}
          </div>
        </div>

        {/* Save / reset actions */}
        <div className="mt-5 flex items-center gap-2 justify-end">
          <span className={`text-[11px] mr-auto ${saveStatus === 'error' ? 'text-red-400' : 'text-[var(--text-dim)]'}`}>
            {saveStatus === 'saved' && t('setting.basic.status.saved')}
            {saveStatus === 'error' && (globalError ?? t('setting.basic.status.error'))}
          </span>
          <button
            type="button"
            onClick={handleReset}
            disabled={!isDirty || saving}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-tertiary)] hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="setting-basic-reset"
          >
            {t('setting.basic.button.reset')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            data-testid="setting-basic-save"
          >
            {saving ? t('setting.basic.button.saving') : t('setting.basic.button.save')}
          </button>
        </div>
      </div>

      {/* Agent list section was removed (SM-3 in v0.1.0-bug-triage):
          agents are listed on the dedicated Agents screen, so duplicating
          the list here added noise without unique value. The
          `data.agents` field is still fetched for backward compatibility
          but no longer rendered. */}
      {/* System concept field was removed (SM-2): the concept had no
          concrete UI use in v0.1.0; the field is fetched but hidden. */}

      {/* Footer */}
      <div className="text-center text-xs text-[var(--text-faint)] py-2">
        {t('setting.basic.footer')}
      </div>
    </div>
  )
}

/**
 * Single editable row used by the basic-settings form. Splits the
 * label, optional badge, help tip, and the input itself so the
 * surrounding form keeps the same vertical rhythm as the read-only
 * version while exposing inline error text and a character counter
 * for fields with a maxLength budget.
 */
function EditableSettingField({
  label,
  value,
  onChange,
  helpText,
  maxLength,
  optional,
  error,
  testId,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  helpText: string
  maxLength: number
  optional?: boolean
  error?: string
  testId?: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-xs text-[var(--text-dim)]">
          {label}
          {optional && (
            <span className="ml-1 text-[10px] text-[var(--text-faint)]">
              ({t('common.optional')})
            </span>
          )}
        </span>
        <HelpTip text={helpText} />
      </div>
      <input
        type="text"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border)] placeholder-[var(--text-dim)] focus:outline-none focus:border-[var(--accent-border)]"
      />
      <div className="mt-1 flex items-center justify-between">
        <p className="text-[11px] text-red-400 min-h-[1em]">{error ?? ''}</p>
        <p className="text-[10px] text-[var(--text-faint)]">
          {value.length}/{maxLength}
        </p>
      </div>
    </div>
  )
}

function SettingRow({ label, value, helpText, highlight }: {
  label: string
  value: string
  helpText: string
  highlight?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
      <span className="text-xs text-[var(--text-dim)]">{label}</span>
      <div className="flex items-center">
        <span className={`text-sm ${highlight ? 'text-[var(--warning-text)]' : 'text-[var(--text-tertiary)]'}`}>
          {value}
        </span>
        <HelpTip text={helpText} />
      </div>
    </div>
  )
}

// --- Skills tab ---

function SettingsSkills() {
  const [data, setData] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    kbFetch('/api/settings/skills')
      .then((r) => r.json())
      .then((res) => setData(res.skills || []))
      .catch((err) => {
        log.warn({ err, endpoint: 'settings/skills' }, 'Failed to load settings')
        setData([])
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  const categoryLabel: Record<string, string> = {
    operation: t('setting.skills.category.operation'),
    procedure: t('setting.skills.category.procedure'),
    knowledge: t('setting.skills.category.knowledge'),
  }
  const categoryColor: Record<string, string> = {
    operation: 'bg-red-500/20 text-red-400',
    procedure: 'bg-blue-500/20 text-blue-400',
    knowledge: 'bg-green-500/20 text-green-400',
  }

  return (
    <div className="space-y-3">
      {data.length > 0 ? (
        data.map((skill) => (
          <div key={skill.name} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">{skill.name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${categoryColor[skill.category] || ''}`}>
                {categoryLabel[skill.category] || skill.category}
              </span>
              <span className="text-xs text-[var(--text-faint)] font-mono ml-auto">{skill.invocation}</span>
            </div>
            <p className="text-xs text-[var(--text-muted)]">{skill.description}</p>
          </div>
        ))
      ) : (
        <EmptyState
          message={t('setting.skills.empty')}
          hint={t('setting.skills.emptyHint')}
        />
      )}
    </div>
  )
}

// --- Automations tab ---

function SettingsAutomations() {
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    kbFetch('/api/settings/automations')
      .then((r) => r.json())
      .then((res) => setHooks(res.hooks || []))
      .catch((err) => {
        log.warn({ err, endpoint: 'settings/automations' }, 'Failed to load settings')
        setHooks([])
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  return (
    <div className="space-y-6">
      {/* Hooks */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-3">{t('setting.automations.section.hooks')}</h3>
        {hooks.length > 0 ? (
          <div className="space-y-2">
            {hooks.map((hook, i) => (
              <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-badge-bg)] text-[var(--accent-text-vivid)]">
                    {hook.event}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-dim)] font-mono truncate">{hook.command}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-dim)]">{t('setting.automations.hooks.empty')}</p>
        )}
      </div>

      {/* Cron */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-3">{t('setting.automations.section.schedule')}</h3>
        <EmptyState
          message={t('setting.automations.schedule.empty')}
        />
      </div>
    </div>
  )
}

// --- Integrations tab ---

function SettingsIntegrations() {
  const [data, setData] = useState<IntegrationInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    kbFetch('/api/settings/integrations')
      .then((r) => r.json())
      .then((res) => setData(res.integrations || []))
      .catch((err) => {
        log.warn({ err, endpoint: 'settings/integrations' }, 'Failed to load settings')
        setData([])
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  return (
    <div>
      {data.length > 0 ? (
        <div className="space-y-2">
          {data.map((item) => (
            <div key={item.name} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--text-secondary)]">{item.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
                    {item.type.toUpperCase()}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                    {item.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          message={t('setting.integrations.empty')}
          hint={t('setting.integrations.emptyHint')}
        />
      )}
    </div>
  )
}

// --- Rules tab ---

function SettingsRules() {
  const [data, setData] = useState<RuleInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    kbFetch('/api/settings/rules')
      .then((r) => r.json())
      .then((res) => setData(res.rules || res || []))
      .catch((err) => {
        log.warn({ err, endpoint: 'settings/rules' }, 'Failed to load settings')
        setData([])
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  return (
    <div>
      {data.length > 0 ? (
        <div className="space-y-2">
          {data.map((rule) => (
            <div key={rule.name} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
              <h4 className="text-sm font-medium text-[var(--text-secondary)] mb-2">{rule.name}</h4>
              <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap line-clamp-4">{rule.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          message={t('setting.rules.empty')}
          hint={t('setting.rules.emptyHint')}
        />
      )}
    </div>
  )
}

// --- Common components ---

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-6 h-6 border-2 border-gray-600 border-t-[var(--accent-border)] rounded-full animate-spin" />
    </div>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-red-400 text-sm">
      {message}
    </div>
  )
}

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="bg-[var(--bg-elevated)] rounded-xl p-6 border border-[var(--border)] text-center">
      <p className="text-sm text-[var(--text-dim)]">{message}</p>
      {hint && (
        <p className="text-xs text-[var(--text-faint)] mt-2">{hint}</p>
      )}
    </div>
  )
}

// --- Ambient Sidebar tab (DEC-020 / EU8) ---

/**
 * SettingsAmbientSidebar — manage per-app pinned agents and global
 * sidebar preferences (DEC-020 v1.1 §2-4 / EU8).
 *
 * The pin map mirrors `setting.json` `ambientSidebar.pinned`. The
 * agent name is resolved against /api/agents; pins whose target has
 * been deleted render with a "deleted" tag so the user can clear
 * stale entries.
 */
function SettingsAmbientSidebar() {
  const { settings, loading, setPin, setGlobalDefault, setOpenByDefault } = useSidebarSettings()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)

  useEffect(() => {
    kbFetch('/api/agents')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AgentInfo[]) => setAgents(data))
      .catch((err) => log.warn({ err }, 'Failed to load agents for ambient sidebar tab'))
      .finally(() => setAgentsLoaded(true))
  }, [])

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of agents) m.set(a.id, a.displayName)
    return m
  }, [agents])

  if (loading || !agentsLoaded) return <LoadingSpinner />

  const pinnedEntries = Object.entries(settings.pinned)

  return (
    <div className="space-y-6">
      {/* Preferences */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">
          {t('setting.ambientSidebar.section.preferences')}
        </h3>
        <div className="space-y-4">
          {/* openByDefault */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              data-testid="setting-ambient-open-by-default"
              checked={settings.openByDefault}
              onChange={(e) => {
                setOpenByDefault(e.target.checked).catch((err) =>
                  log.warn({ err }, 'Failed to update openByDefault'),
                )
              }}
              className="mt-0.5"
            />
            <span className="text-sm text-[var(--text-secondary)]">
              {t('setting.ambientSidebar.openByDefault')}
            </span>
          </label>

          {/* globalDefault */}
          <div className="flex items-center gap-3">
            <label
              htmlFor="setting-ambient-global-default"
              className="text-sm text-[var(--text-secondary)] shrink-0"
            >
              {t('setting.ambientSidebar.globalDefault.label')}
            </label>
            <select
              id="setting-ambient-global-default"
              data-testid="setting-ambient-global-default"
              value={settings.globalDefault ?? ''}
              onChange={(e) => {
                const next = e.target.value === '' ? null : e.target.value
                setGlobalDefault(next).catch((err) =>
                  log.warn({ err }, 'Failed to update globalDefault'),
                )
              }}
              className="
                text-sm rounded border border-[var(--border)]
                bg-[var(--bg-base)] text-[var(--text-secondary)]
                px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
              "
            >
              <option value="">{t('setting.ambientSidebar.globalDefault.unselected')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Pinned per-app */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">
          {t('setting.ambientSidebar.section.pinned')}
        </h3>
        {pinnedEntries.length === 0 ? (
          <p className="text-sm text-[var(--text-dim)]">
            {t('setting.ambientSidebar.empty')}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="setting-ambient-pinned-list">
            {pinnedEntries.map(([appId, agentId]) => {
              const agentName = agentId ? agentNameById.get(agentId) : null
              const isDeleted = agentId !== null && !agentName
              return (
                <li
                  key={appId}
                  className="flex items-center gap-3 py-1.5 border-b border-[var(--border)] last:border-b-0"
                >
                  <span className="text-xs font-mono text-[var(--text-dim)] shrink-0 w-32 truncate">
                    {appId}
                  </span>
                  <span className={`text-sm flex-1 truncate ${isDeleted ? 'text-[var(--text-faint)] italic' : 'text-[var(--text-secondary)]'}`}>
                    {agentId === null
                      ? t('setting.ambientSidebar.unpinned')
                      : (agentName ?? `${agentId} ${t('setting.ambientSidebar.deleted')}`)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setPin(appId, null).catch((err) =>
                        log.warn({ err, appId }, 'Failed to unpin'),
                      )
                    }}
                    className="text-xs px-2 py-1 rounded text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
                  >
                    {t('setting.ambientSidebar.unpin')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
