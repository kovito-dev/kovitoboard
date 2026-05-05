/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * accessibility-snapshot — capture a viewport-scoped, size-bounded
 * snapshot of the user's screen as a Markdown a11y block for the
 * ambient sidebar (DEC-020 / EU8 Phase 4).
 *
 * Why a custom DOM walker rather than a npm package or
 * Element.computedRole / computedName?
 *
 *   - DEC-020 R1 keeps new npm additions minimal. Off-the-shelf
 *     accessibility-tree libraries pull in either a heavy WAI-ARIA
 *     implementation or a Chrome DevTools Protocol bridge — neither is
 *     justified for the small subset we surface to the agent.
 *   - `Element.computedRole` is Chromium-only and unimplemented in
 *     jsdom, so unit testing the walker would degrade.
 *   - A 150-line walker keeps the spec §2.4 contract honest (viewport
 *     filter, 50 KB cap, fenced ```a11y output) and reads cleanly when
 *     we extend to Selected / ExposedContext blocks in Phase 5.
 */

/** Hard size cap per spec §2.4. The serialized block is truncated at
 *  this many characters to keep token cost predictable on large DOMs. */
export const MAX_SNAPSHOT_BYTES = 50_000

/** Soft warning threshold per spec §2.4. Snapshots that take longer
 *  than this on the wall clock log a perf warning but still ship. */
export const SNAPSHOT_PERF_WARN_MS = 1_000

/** Element types we never recurse into — they add markup volume but
 *  carry no useful semantic context for an LLM. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH'])

/** ARIA roles + tag-name fallbacks we surface to the agent. The
 *  mapping is intentionally narrow: an LLM benefits more from a clean
 *  outline than from every span on the page. */
const ROLE_BY_TAG: Record<string, string> = {
  H1: 'heading[level=1]',
  H2: 'heading[level=2]',
  H3: 'heading[level=3]',
  H4: 'heading[level=4]',
  H5: 'heading[level=5]',
  H6: 'heading[level=6]',
  A: 'link',
  BUTTON: 'button',
  INPUT: 'input',
  TEXTAREA: 'textbox',
  SELECT: 'combobox',
  LABEL: 'label',
  NAV: 'navigation',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  MAIN: 'main',
  ASIDE: 'complementary',
  ARTICLE: 'article',
  SECTION: 'region',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  TABLE: 'table',
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
  FORM: 'form',
  IMG: 'image',
  DIALOG: 'dialog',
}

interface SnapshotOptions {
  /**
   * Root element to walk. Defaults to `document.body`. Pass a
   * narrower root when you want to exclude the sidebar itself or
   * other UI chrome from the capture.
   */
  root?: Element
  /**
   * When true, only include elements that intersect the viewport
   * (default true). Spec §2.4 — keeps capture bounded on long pages.
   */
  viewportOnly?: boolean
  /** Override the size cap (mainly for testing). */
  maxBytes?: number
}

interface SnapshotResult {
  /** Full Markdown block ready to embed in a prompt. */
  block: string
  /** Number of nodes actually emitted (for diagnostics). */
  nodeCount: number
  /** True when the cap was hit and the output was truncated. */
  truncated: boolean
  /** Wall-clock time in ms. */
  elapsedMs: number
}

/** Resolve a role string for an element. ARIA `role` attribute wins. */
function resolveRole(el: Element): string | null {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName
  if (ROLE_BY_TAG[tag]) {
    // Refine button-vs-input by `type` for the most common cases.
    if (tag === 'INPUT') {
      const t = (el as HTMLInputElement).type
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      return 'input'
    }
    return ROLE_BY_TAG[tag]
  }
  return null
}

/** Resolve an accessible name. Mirrors a small subset of the WAI-ARIA
 *  name computation: aria-label > aria-labelledby > <label for> >
 *  text content. */
function resolveName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return ariaLabel.trim()

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const ref = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ')
    if (ref) return ref
  }

  const id = el.id
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (label?.textContent) return label.textContent.trim()
  }

  // For form controls, `placeholder` is a reasonable fallback.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.value) return el.value.slice(0, 80)
    if (el.placeholder) return `(placeholder: ${el.placeholder.slice(0, 80)})`
  }

  // Otherwise, collapse direct text to a single line.
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 120)
}

/** True when an element's bounding rect intersects the viewport. */
function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const vh = window.innerHeight || document.documentElement.clientHeight
  const vw = window.innerWidth || document.documentElement.clientWidth
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw
}

/**
 * Walk the DOM and emit one indented line per role-bearing element.
 * Lines are emitted depth-first so the indentation reflects nesting,
 * giving the LLM a readable outline.
 */
function walk(root: Element, opts: Required<SnapshotOptions>, lines: string[], remaining: { bytes: number }): {
  nodeCount: number
  truncated: boolean
} {
  let nodeCount = 0
  let truncated = false

  const stack: Array<{ el: Element; depth: number }> = [{ el: root, depth: 0 }]

  while (stack.length > 0) {
    const { el, depth } = stack.shift()!  // BFS; switch to pop() for DFS

    if (SKIP_TAGS.has(el.tagName)) continue
    if (opts.viewportOnly && !isInViewport(el)) continue

    const role = resolveRole(el)
    if (role) {
      const name = resolveName(el)
      const indent = '  '.repeat(Math.min(depth, 8))
      const line = name
        ? `${indent}- ${role}: "${name.replace(/"/g, '\\"')}"`
        : `${indent}- ${role}`
      // +1 for newline.
      const cost = line.length + 1
      if (cost > remaining.bytes) {
        truncated = true
        break
      }
      lines.push(line)
      remaining.bytes -= cost
      nodeCount++
    }

    // Always recurse, even when the parent contributed nothing — child
    // elements may still carry roles (e.g. div > button).
    for (const child of Array.from(el.children)) {
      stack.push({ el: child, depth: depth + 1 })
    }
  }

  return { nodeCount, truncated }
}

/**
 * Capture a snapshot. Returns null on unrecoverable errors so the
 * caller can fall back to sending the message without a11y context
 * (spec §2.4 — fail-silent).
 */
export function captureAccessibilitySnapshot(options: SnapshotOptions = {}): SnapshotResult | null {
  try {
    const opts: Required<SnapshotOptions> = {
      root: options.root ?? document.body,
      viewportOnly: options.viewportOnly ?? true,
      maxBytes: options.maxBytes ?? MAX_SNAPSHOT_BYTES,
    }

    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const lines: string[] = []
    // Reserve a few bytes for the fence wrapper.
    const fenceOverhead = '```a11y\n```\n'.length
    const remaining = { bytes: Math.max(0, opts.maxBytes - fenceOverhead) }

    const { nodeCount, truncated } = walk(opts.root, opts, lines, remaining)

    const block = ['```a11y', ...lines, '```'].join('\n')
    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start

    return { block, nodeCount, truncated, elapsedMs }
  } catch {
    return null
  }
}
