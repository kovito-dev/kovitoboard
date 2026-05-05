/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
 * Resolve a usable accent color even when the caller forgot to supply
 * one (or supplied an empty string). Defaults to neutral greys that
 * read well against either theme's chrome — keeps the auto-generated
 * border / background from collapsing to pure black when the agent
 * config has no `color` field set.
 *
 * AD-1: black borders in light mode were the most visible regression
 * and stemmed from `color === undefined` falling through to the
 * browser's default `currentColor`.
 */
function resolveSafeColor(color: string | undefined, theme: 'dark' | 'light'): string {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color
  return theme === 'light' ? '#7c8198' : '#a4a8c0'
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

  const safeColor = resolveSafeColor(color, theme)

  // Deterministically generate SVG icon (memoized)
  const generatedSvg = useMemo(() => {
    const seed = agentId || name
    return generateAgentIconSvg({ agentId: seed, themeColor: safeColor, theme })
  }, [agentId, name, safeColor, theme])

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
          border: `2px solid ${safeColor}`,
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
        border: `2px solid ${safeColor}`,
      }}
      dangerouslySetInnerHTML={{ __html: generatedSvg }}
    />
  )
}
