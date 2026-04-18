import { AgentAvatar } from './AgentAvatar'
import type { AgentConfig } from '../types'
import type { Theme } from '../hooks/useTheme'

/** Agent active status */
export interface AgentStatus {
  agentId: string
  hasActiveSession: boolean
}

interface TitleBarProps {
  /** Project name (displayed in logo area) */
  projectName: string
  /** Project description (displayed next to logo) */
  projectDescription?: string
  /** Agent definitions from viewer.config.json (key: agent ID) */
  agentConfigs: Record<string, AgentConfig>
  /** Active status of each agent */
  agentStatuses: AgentStatus[]
  /** Callback when an agent icon is clicked */
  onAgentClick: (agentId: string) => void
  /** Callback to open settings modal */
  onOpenSettings?: () => void
  /** Current theme */
  theme?: Theme
  /** Theme toggle callback */
  onToggleTheme?: () => void
}

export function TitleBar({ projectName, projectDescription, agentConfigs, agentStatuses, onAgentClick, onOpenSettings, theme, onToggleTheme }: TitleBarProps) {
  return (
    <div className="bg-[var(--bg-surface)] flex items-center justify-between px-3 md:px-5 border-b border-[var(--border)] select-none h-14 md:h-[100px]">
      {/* Left: project name + description */}
      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-lg md:text-2xl font-bold tracking-widest text-[var(--text-tertiary)]">{projectName}</span>
        </div>
        {projectDescription && (
          <>
            <div className="w-px h-6 md:h-8 bg-[var(--border)] hidden sm:block" />
            <span className="text-sm text-[var(--text-muted)] truncate max-w-48 md:max-w-96 hidden sm:block">{projectDescription}</span>
          </>
        )}
      </div>

      {/* Right: agent icon buttons + theme toggle + settings button */}
      <div className="flex items-center gap-1 md:gap-2 shrink-0">
        {agentStatuses.map(({ agentId, hasActiveSession }) => {
          const cfg = agentConfigs[agentId]
          if (!cfg) return null
          return (
            <button
              key={agentId}
              onClick={() => onAgentClick(agentId)}
              className="relative group p-0.5 md:p-1 rounded-full transition-all duration-150 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20"
              title={cfg.name}
            >
              <AgentAvatar
                name={cfg.name}
                color={cfg.color}
                size={32}
                avatar={cfg.avatar}
                agentId={agentId}
                theme={theme}
              />
              {/* Active indicator */}
              {hasActiveSession && (
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-emerald-400 border-2 border-[var(--bg-surface)]" />
              )}
              {/* Show agent name tooltip on hover */}
              <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-[10px] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none hidden md:block">
                {cfg.name}
              </span>
            </button>
          )
        })}

        {/* Separator */}
        <div className="w-px h-5 md:h-6 bg-[var(--border)] mx-0.5 md:mx-1" />

        {/* Theme toggle button */}
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className="p-1.5 md:p-2 rounded-full transition-all duration-150 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              /* Sun icon (dark -> switch to light) */
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] md:w-5 md:h-5">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              /* Moon icon (light -> switch to dark) */
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] md:w-5 md:h-5">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        )}

        {/* Gear button */}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="p-1.5 md:p-2 rounded-full transition-all duration-150 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20"
            title="設定"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] md:w-5 md:h-5">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
