import { useState, useMemo } from 'react'
import { generateAgentIconSvg } from '../utils/generate-agent-icon'

interface AgentAvatarProps {
  name: string
  color: string
  size?: number
  avatar?: string
  /** エージェントID（SVGジェネレーターのシード値）。未指定時は name を使用 */
  agentId?: string
  /** UIテーマ（SVG背景色の切り替えに使用） */
  theme?: 'dark' | 'light'
}

/**
 * avatar ファイル名からテーマに応じたパスを解決する
 * 例: "secretary.svg" + light → "/avatars/secretary-light.svg"
 * ライト版が読み込み失敗した場合はダーク版にフォールバック → さらに失敗時はランタイム生成
 */
function resolveAvatarSrc(avatar: string, theme: 'dark' | 'light'): string {
  if (theme === 'dark') return `/avatars/${avatar}`
  // ライトモード: {id}-light.svg を試行
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
  // ライト版が失敗した場合にダーク版（元ファイル）を試行するフラグ
  const [lightFallback, setLightFallback] = useState(false)

  // SVGアイコンを決定論的に生成（メモ化）
  const generatedSvg = useMemo(() => {
    const seed = agentId || name
    return generateAgentIconSvg({ agentId: seed, themeColor: color, theme })
  }, [agentId, name, color, theme])

  // avatar がありかつ読み込みエラーでない場合は画像表示
  if (avatar && !imgError) {
    // テーマに応じたパスを解決（ライト版が未対応ならダーク版にフォールバック）
    const src = lightFallback ? `/avatars/${avatar}` : resolveAvatarSrc(avatar, theme)
    return (
      <img
        src={src}
        alt={name}
        onError={() => {
          if (theme === 'light' && !lightFallback) {
            // ライト版が存在しない → ダーク版を試行
            setLightFallback(true)
          } else {
            // ダーク版も失敗 → ランタイム生成にフォールバック
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

  // フォールバック: SVGジェネレーターで自動生成
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
