/**
 * generate-agent-icon.ts — Automatic SVG icon generation for agents.
 *
 * Deterministically generates SVG icons from agent IDs using a djb2 hash as seed.
 * No image files need to be saved; SVG strings are generated at runtime for inline rendering.
 */

// --- djb2 hash function (no cryptographic strength required) ---

function djb2(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  }
  return hash
}

// --- Base shape definitions ---

type ShapeGenerator = (cx: number, cy: number, r: number, rotation: number, color: string) => string

/** Circle */
const circle: ShapeGenerator = (_cx, _cy, r, _rotation, color) =>
  `<circle cx="50" cy="50" r="${r}" fill="${color}" />`

/** Hexagon */
const hexagon: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i + (rotation * Math.PI) / 180
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** Diamond */
const diamond: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 4 }, (_, i) => {
    const angle = (Math.PI / 2) * i + (rotation * Math.PI) / 180
    const scale = i % 2 === 0 ? r : r * 0.65
    return `${cx + scale * Math.cos(angle)},${cy + scale * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** 5-pointed star */
const star5: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 10 }, (_, i) => {
    const angle = (Math.PI / 5) * i - Math.PI / 2 + (rotation * Math.PI) / 180
    const rad = i % 2 === 0 ? r : r * 0.45
    return `${cx + rad * Math.cos(angle)},${cy + rad * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** 6-pointed star */
const star6: ShapeGenerator = (cx, cy, r, rotation, color) => {
  const points = Array.from({ length: 12 }, (_, i) => {
    const angle = (Math.PI / 6) * i + (rotation * Math.PI) / 180
    const rad = i % 2 === 0 ? r : r * 0.5
    return `${cx + rad * Math.cos(angle)},${cy + rad * Math.sin(angle)}`
  }).join(' ')
  return `<polygon points="${points}" fill="${color}" />`
}

/** Double circle */
const doubleCircle: ShapeGenerator = (_cx, _cy, r, _rotation, color) =>
  `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="3" />` +
  `<circle cx="50" cy="50" r="${r * 0.6}" fill="${color}" />`

const SHAPES: ShapeGenerator[] = [circle, hexagon, diamond, star5, star6, doubleCircle]

// --- Inner pattern definitions ---

type PatternGenerator = (cx: number, cy: number, r: number, hash: number, color: string) => string

/** Radial lines */
const radialLines: PatternGenerator = (cx, cy, r, hash, color) => {
  const count = 4 + (hash % 5) // 4-8 lines
  return Array.from({ length: count }, (_, i) => {
    const angle = ((Math.PI * 2) / count) * i
    const x2 = cx + r * 0.85 * Math.cos(angle)
    const y2 = cy + r * 0.85 * Math.sin(angle)
    return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" />`
  }).join('')
}

/** Dot placement */
const dots: PatternGenerator = (cx, cy, r, hash, color) => {
  const count = 3 + (hash % 4) // 3-6 dots
  return Array.from({ length: count }, (_, i) => {
    const angle = ((Math.PI * 2) / count) * i + ((hash * 13) % 360) * Math.PI / 180
    const dist = r * 0.5
    const x = cx + dist * Math.cos(angle)
    const y = cy + dist * Math.sin(angle)
    const dotR = 2 + (hash % 3)
    return `<circle cx="${x}" cy="${y}" r="${dotR}" fill="${color}" />`
  }).join('')
}

/** Concentric circles */
const concentricCircles: PatternGenerator = (cx, cy, r, _hash, color) =>
  `<circle cx="${cx}" cy="${cy}" r="${r * 0.7}" fill="none" stroke="${color}" stroke-width="1.2" />` +
  `<circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="none" stroke="${color}" stroke-width="1.2" />`

/** None */
const noPattern: PatternGenerator = () => ''

const PATTERNS: PatternGenerator[] = [radialLines, dots, concentricCircles, noPattern]

// --- Color utilities ---

/** Convert a HEX color to an RGBA value with the given opacity */
function withOpacity(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${opacity})`
}

// --- Main generation function ---

export interface AgentIconParams {
  agentId: string
  themeColor: string
  /** UI theme ('dark' | 'light'). Default: 'dark' */
  theme?: 'dark' | 'light'
}

/** Darken a theme color (for light mode) */
function darkenColor(hex: string, factor: number): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor)
  return `rgb(${Math.min(r, 255)},${Math.min(g, 255)},${Math.min(b, 255)})`
}

/**
 * Generate an SVG string from an agent ID and theme color.
 * Always returns the same output for the same input (deterministic).
 */
export function generateAgentIconSvg({ agentId, themeColor, theme = 'dark' }: AgentIconParams): string {
  const hash = djb2(agentId)

  // Derive parameters from the hash
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
    // Background circle
    `<circle cx="${cx}" cy="${cy}" r="46" fill="${bgColor}" />`,
    // Decorative circle with sub-color
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${subColor}" />`,
    // Base shape
    shape(cx, cy, innerR, rotation, effectiveColor),
    // Inner pattern
    pattern(cx, cy, innerR, hash >>> 12, withOpacity(effectiveColor, isLight ? 0.4 : 0.6)),
  ].join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svgContent}</svg>`
}
