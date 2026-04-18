import { useState, useMemo } from 'react'
import { generateAgentIconSvg } from '../utils/generate-agent-icon'

interface AgentAvatarProps {
  name: string
  color: string
  size?: number
  avatar?: string
  /** Agent ID (seed for SVG generator). Falls back to name when unspecified */
  agentId?: string
  /** UI theme (used for switching SVG background color) */
  theme?: 'dark' | 'light'
}

/**
 * Resolve the avatar file path based on the theme.
 * e.g. "secretary.svg" + light -> "/avatars/secretary-light.svg"
 * Falls back to the dark variant on load failure, then to runtime generation.
 */
function resolveAvatarSrc(avatar: string, theme: 'dark' | 'light'): string {
  if (theme === 'dark') return `/avatars/${avatar}`
  // Light mode: try {id}-light.svg
  const dotIdx = avatar.lastIndexOf('.')
  if (dotIdx > 0) {
    const base = avatar.slice(0, dotIdx)
    const ext = avatar.slice(dotIdx)
    return `/avatars/${base}-light${ext}`
  }
  return `/avatars/${avatar}`
}

export function AgentAvatar({ name, color, size = 36, avatar, agentId, theme = 'dark' }: AgentAvatarProps) {
  const [imgError, setImgError] = useState(false)
  // Flag to try the dark variant (original file) when the light variant fails
  const [lightFallback, setLightFallback] = useState(false)

  // Deterministically generate SVG icon (memoized)
  const generatedSvg = useMemo(() => {
    const seed = agentId || name
    return generateAgentIconSvg({ agentId: seed, themeColor: color, theme })
  }, [agentId, name, color, theme])

  // Display the image if avatar is set and no load error occurred
  if (avatar && !imgError) {
    // Resolve theme-aware path (fall back to dark variant if light is unavailable)
    const src = lightFallback ? `/avatars/${avatar}` : resolveAvatarSrc(avatar, theme)
    return (
      <img
        src={src}
        alt={name}
        onError={() => {
          if (theme === 'light' && !lightFallback) {
            // Light variant not found -> try dark variant
            setLightFallback(true)
          } else {
            // Dark variant also failed -> fall back to runtime generation
            setImgError(true)
          }
        }}
        className="rounded-full object-cover shrink-0"
        style={{
          width: size,
          height: size,
          border: `2px solid ${color}`,
        }}
      />
    )
  }

  // Fallback: auto-generate with SVG generator
  return (
    <div
      className="rounded-full overflow-hidden shrink-0"
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}`,
      }}
      dangerouslySetInnerHTML={{ __html: generatedSvg }}
    />
  )
}
