/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { t } from '../i18n'

interface WelcomeBannerProps {
  projectName: string
  agents: { name: string; role: string; summary: string }[]
  onNavigateToAgents: () => void
}

export function WelcomeBanner({ projectName, agents, onNavigateToAgents }: WelcomeBannerProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-3 md:p-6">
      <div className="max-w-xl w-full">
        <div className="bg-[var(--bg-elevated)] rounded-2xl border border-[var(--border)] p-4 md:p-8 space-y-4 md:space-y-6">
          {/* Header */}
          <div className="text-center">
            <h1 className="text-xl md:text-2xl font-bold text-[var(--text-primary)] mb-2">
              Welcome to {projectName}!
            </h1>
            <p className="text-sm text-[var(--text-dim)]">
              {t('welcome.subtitle')}
            </p>
          </div>

          {/* Agent list */}
          {agents.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--text-muted)] text-center">
                {t('welcome.agentCount', { count: agents.length })}
              </p>
              <div className="space-y-2">
                {agents.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-secondary)]">{agent.name}{agent.role ? `（${agent.role}）` : ''}</div>
                      {agent.summary && (
                        <div className="text-xs text-[var(--text-dim)] mt-0.5">{agent.summary}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Separator */}
          <div className="border-t border-[var(--border)]" />

          {/* Getting started */}
          {agents.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">
                {t('welcome.gettingStarted')}
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                {t('welcome.selectAgent')}
              </p>

              <button
                onClick={onNavigateToAgents}
                className="w-full mt-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-[var(--accent-strong)] hover:bg-[var(--accent)] text-white transition-colors"
              >
                {t('welcome.button.viewAgents')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">
                {t('welcome.gettingStarted')}
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                {t('welcome.createAgentHint')}
              </p>
              <p className="text-xs text-[var(--text-dim)]">
                {t('welcome.agentDirHint')}
              </p>
              <p className="text-xs text-[var(--text-faint)]">
                {t('welcome.seeGuideHint')}
              </p>
            </div>
          )}

          {/* Settings hint */}
          <p className="text-center text-xs text-[var(--text-faint)]">
            {t('welcome.settingsHint')}
          </p>
        </div>
      </div>
    </div>
  )
}
