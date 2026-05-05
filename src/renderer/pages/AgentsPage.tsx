/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SessionSummary, ViewerConfig, AgentInfo } from '../types'
import { AgentList } from '../components/AgentList'
import { WelcomeBanner } from '../components/WelcomeBanner'

interface AgentsPageProps {
  agents: AgentInfo[]
  sessions: SessionSummary[]
  config: ViewerConfig | null
  theme: 'dark' | 'light'
}

export function AgentsPage({ agents, sessions, config, theme }: AgentsPageProps) {
  const navigate = useNavigate()

  // The welcome banner is the first screen on a freshly-onboarded project.
  // Its primary action is "View agents" — but since we are already at
  // /agents, react-router would no-op on `navigate('/agents')` and the
  // banner would never disappear (sessions.length stays 0 until the user
  // actually starts a session). A local dismissed flag swaps to the agent
  // list without requiring any session to exist first.
  const [bannerDismissed, setBannerDismissed] = useState(false)

  const handleAgentSelect = (agentId: string) => {
    navigate(`/agents/${agentId}`)
  }

  // Initial launch: show welcome banner if no sessions exist and the user
  // has not dismissed it via the "View agents" button.
  if (sessions.length === 0 && !bannerDismissed) {
    const projectName = config?.project?.name || 'KovitoBoard'
    const agentList = config?.agents
      ? Object.entries(config.agents)
          .filter(([id]) => id !== 'default')
          .map(([, cfg]) => ({
            name: cfg.name,
            role: '',
            summary: cfg.summary || '',
          }))
      : []

    return (
      <WelcomeBanner
        projectName={projectName}
        agents={agentList}
        onNavigateToAgents={() => setBannerDismissed(true)}
      />
    )
  }

  const handleAddAgent = () => {
    navigate('/agents/new')
  }

  return <AgentList agents={agents} onSelectAgent={handleAgentSelect} onAddAgent={handleAddAgent} theme={theme} />
}
