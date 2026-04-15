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

  const handleAgentSelect = (agentId: string) => {
    navigate(`/agents/${agentId}`)
  }

  // Initial launch: show welcome banner if no sessions exist
  if (sessions.length === 0) {
    const projectName = config?.project?.name || 'KovitoBoard'
    const conceptVal = config?.project?.concept || null
    const agentList = config?.agents
      ? Object.entries(config.agents)
          .filter(([id]) => id !== 'default')
          .map(([, cfg]) => ({
            name: cfg.name,
            role: '',
            summary: cfg.summary || '',
          }))
      : []
    const secretaryEntry = config?.agents
      ? Object.entries(config.agents).find(([id]) => id !== 'default')
      : null
    const secName = secretaryEntry ? secretaryEntry[1].name : '秘書'
    const secId = secretaryEntry ? secretaryEntry[0] : ''

    return (
      <WelcomeBanner
        projectName={projectName}
        concept={conceptVal || null}
        agents={agentList}
        secretaryName={secName}
        onNavigateToAgents={() => handleAgentSelect(secId)}
      />
    )
  }

  return <AgentList agents={agents} onSelectAgent={handleAgentSelect} theme={theme} />
}
