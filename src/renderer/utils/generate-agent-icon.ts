/**
 * generate-agent-icon.ts — エージェントアイコンSVG自動生成
 *
 * エージェントIDをシード値としたハッシュから、決定論的にSVGアイコンを生成する。
 * 画像ファイルの保存は不要で、ランタイムでSVG文字列を生成してインラインレンダリングする。
 *
 * Generates deterministic SVG icons from agent IDs using djb2 hash.
 */

// --- djb2 ハッシュ関数（暗号学的強度不要） ---

function djb2(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  }
  return hash
}

// --- ベースシェイプ定義 ---

type ShapeGenerator = (cx: number, cy: number, r: number, rotation: number, color: string) => string

/** 円 */
const circle: ShapeGenerator = (_cx, _cy, r, _rotation, color) =>
  `<circle cx="50" cy="50" r="${r}" fill="${color}" />`

/** 六角形 */
const hexagon: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i + (rotation * Math.PI) / 180
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** 菱形 */
const diamond: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 4 }, (_, i) => {
    const angle = (Math.PI / 2) * i + (rotation * Math.PI) / 180
    const scale = i % 2 === 0 ? r : r * 0.65
    return `${cx + scale * Math.cos(angle)},${cy + scale * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** 星形（5角） */
const star5: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 10 }, (_, i) => {
    const angle = (Math.PI / 5) * i - Math.PI / 2 + (rotation * Math.PI) / 180
    const rad = i % 2 === 0 ? r : r * 0.45
    return `${cx + rad * Math.cos(angle)},${cy + rad * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** 星形（6角） */
const star6: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 12 }, (_, i) => {
    const angle = (Math.PI / 6) * i + (rotation * Math.PI) / 180
    const rad = i % 2 === 0 ? r : r * 0.5
    return `${cx + rad * Math.cos(angle)},${cy + rad * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** 二重円 */
const doubleCircle: ShapeGenerator = (_cx, _cy, r, _rotation, color) =>
  `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="3" />` +
  `<circle cx="50" cy="50" r="${r * 0.6}" fill="${color}" />`

const SHAPES: ShapeGenerator[] = [circle, hexagon, diamond, star5, star6, doubleCircle]

// --- 内部パターン定義 ---

type PatternGenerator = (cx: number, cy: number, r: number, hash: number, color: string) => string

/** 放射線 */
const radialLines: PatternGenerator = (cx, cy, r, hash, color) => {
  const count = 4 + (hash % 5) // 4〜8本
  return Array.from({ length: count }, (_, i) => {
    const angle = ((Math.PI * 2) / count) * i
    const x2 = cx + r * 0.85 * Math.cos(angle)
    const y2 = cy + r * 0.85 * Math.sin(angle)
    return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" />`
  }).join('')
}

/** ドット配置 */
const dots: PatternGenerator = (cx, cy, r, hash, color) => {
  const count = 3 + (hash % 4) // 3〜6個
  return Array.from({ length: count }, (_, i) => {
    const angle = ((Math.PI * 2) / count) * i + ((hash * 13) % 360) * Math.PI / 180
    const dist = r * 0.5
    const x = cx + dist * Math.cos(angle)
    const y = cy + dist * Math.sin(angle)
    const dotR = 2 + (hash % 3)
    return `<circle cx="${x}" cy="${y}" r="${dotR}" fill="${color}" />`
  }).join('')
}

/** 同心円 */
const concentricCircles: PatternGenerator = (cx, cy, r, _hash, color) =>
  `<circle cx="${cx}" cy="${cy}" r="${r * 0.7}" fill="none" stroke="${color}" stroke-width="1.2" />` +
  `<circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="none" stroke="${color}" stroke-width="1.2" />`

/** なし */
const noPattern: PatternGenerator = () => ''

const PATTERNS: PatternGenerator[] = [radialLines, dots, concentricCircles, noPattern]

// --- カラーユーティリティ ---

/** HEXカラーを透過版にする */
function withOpacity(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${opacity})`
}

// --- メイン生成関数 ---

export interface AgentIconParams {
  agentId: string
  themeColor: string
  /** UI テーマ（'dark' | 'light'）。デフォルト: 'dark' */
  theme?: 'dark' | 'light'
}

/** テーマカラーを濃くする（ライトモード用） */
function darkenColor(hex: string, factor: number): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor)
  return `rgb(${Math.min(r, 255)},${Math.min(g, 255)},${Math.min(b, 255)})`
}

/**
 * エージェントIDとテーマカラーからSVG文字列を生成する。
 * 同じ入力には常に同じ出力を返す（決定論的）。
 */
export function generateAgentIconSvg({ agentId, themeColor, theme = 'dark' }: AgentIconParams): string {
  const hash = djb2(agentId)

  // ハッシュからパラメータを導出
  const shapeIndex = hash % SHAPES.length
  const rotation = (hash * 37) % 360
  const patternIndex = (hash >>> 4) % PATTERNS.length
  const sizeRatio = 0.4 + ((hash >>> 8) % 4) * 0.1 // 0.4〜0.7

  const cx = 50
  const cy = 50
  const outerR = 38
  const innerR = outerR * sizeRatio

  const isLight = theme === 'light'
  const bgColor = isLight ? '#eeeef6' : '#1a1a2e'
  const effectiveColor = isLight ? darkenColor(themeColor, 0.8) : themeColor
  const subColor = withOpacity(effectiveColor, isLight ? 0.15 : 0.3)

  const shape = SHAPES[shapeIndex]
  const pattern = PATTERNS[patternIndex]

  const svgContent = [
    // 背景円
    `<circle cx="${cx}" cy="${cy}" r="46" fill="${bgColor}" />`,
    // サブカラーの装飾円
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${subColor}" />`,
    // ベースシェイプ
    shape(cx, cy, innerR, rotation, effectiveColor),
    // 内部パターン
    pattern(cx, cy, innerR, hash >>> 12, withOpacity(effectiveColor, isLight ? 0.4 : 0.6)),
  ].join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svgContent}</svg>`
}
