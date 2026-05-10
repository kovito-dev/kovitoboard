/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * element-picker — modal pointer-based element selection for the
 * α-method screen-context channel (DEC-020 / EU8 Phase 5).
 *
 * The user opts into "pick a screen element" mode from the ambient
 * sidebar. While active, hovering any element draws a high-contrast
 * outline; clicking commits the selection and exits the mode. Esc or
 * a second click on the trigger cancels.
 *
 * Implementation choices:
 *   - DOM-only outline (no React portal). The picker overlays the
 *     entire app, including sidebars, and React state would force
 *     re-renders on every mousemove.
 *   - Capture-phase listeners on document. When the user clicks an
 *     element we stop the event so the click does not also trigger the
 *     element's own onClick — picking should be inert.
 *   - The picker excludes the ambient sidebar's own DOM (selector
 *     `[data-testid="ambient-sidebar"]`) so the user cannot pick the
 *     picker UI itself.
 */

const SIDEBAR_SELECTOR = '[data-testid="ambient-sidebar"]'

/** Z-index that sits above all KB chrome (modals are 50). */
const OVERLAY_Z = 9999

interface PickerHandlers {
  /** Fired with the picked element on commit. */
  onPick: (element: Element) => void
  /** Fired when the user cancels (Esc or trigger toggle). */
  onCancel: () => void
}

interface PickerHandle {
  /** Tear down listeners and remove the overlay. Idempotent. */
  stop(): void
}

/** True when `el` is part of the ambient sidebar's own DOM. */
function isInsideSidebar(el: Element): boolean {
  return el.closest(SIDEBAR_SELECTOR) !== null
}

/**
 * Activate element-pick mode. The returned handle can be stopped from
 * the React layer (e.g. when a different agent is picked or the
 * sidebar is closed mid-pick).
 */
export function activateElementPicker(handlers: PickerHandlers): PickerHandle {
  // Outline overlay — a single absolute-positioned div repositioned on
  // mousemove. We use an outline rather than a border so it doesn't
  // shift the layout under the cursor.
  const overlay = document.createElement('div')
  overlay.setAttribute('data-testid', 'ambient-sidebar-picker-overlay')
  overlay.style.position = 'fixed'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = String(OVERLAY_Z)
  overlay.style.outline = '2px solid var(--accent-border, #6366f1)'
  overlay.style.outlineOffset = '0px'
  overlay.style.boxShadow = '0 0 0 9999px rgba(0, 0, 0, 0.05)'
  overlay.style.transition = 'left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear'
  overlay.style.display = 'none'
  document.body.appendChild(overlay)

  let stopped = false
  let lastTarget: Element | null = null

  const repositionOverlay = (el: Element) => {
    const rect = el.getBoundingClientRect()
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    overlay.style.display = 'block'
  }

  const onMove = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (!target || isInsideSidebar(target)) {
      overlay.style.display = 'none'
      lastTarget = null
      return
    }
    if (target === lastTarget) return
    lastTarget = target
    repositionOverlay(target)
  }

  const onClick = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (!target || isInsideSidebar(target)) return
    e.preventDefault()
    e.stopPropagation()
    stop()
    handlers.onPick(target)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      stop()
      handlers.onCancel()
    }
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }

  // Capture-phase listeners so we beat the target's own handlers.
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)

  return { stop }
}

/**
 * Serialize a picked element into a compact text snippet suitable for
 * the `selected` section of the agent payload (spec §2.4 α-method).
 *
 * Includes the element's text content (capped), its tag/role, and a
 * small slice of immediate child structure so the agent can reason
 * about what the user picked even when the text is generic ("OK").
 *
 * The output is wrapped in a rule-line sentinel by the caller
 * (`AmbientSidebar.composePayload`); the previous ` ```Selected `
 * fence was removed in the K-15 cutover (spec
 * `kb-authored-sentinel.md` v1.3 §11.3).
 */
export function describePickedElement(el: Element, opts: { maxTextLength?: number } = {}): string {
  const maxText = opts.maxTextLength ?? 200
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role') ?? ''
  const ariaLabel = el.getAttribute('aria-label') ?? ''
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const truncatedText = text.length > maxText ? `${text.slice(0, maxText)}…` : text

  // Up to 5 immediate children, role/tag + first 40 chars each.
  const childrenSummary = Array.from(el.children)
    .slice(0, 5)
    .map((c) => {
      const ctag = c.tagName.toLowerCase()
      const crole = c.getAttribute('role') ?? ''
      const ctext = (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
      const labelParts = [ctag, crole].filter(Boolean).join('/')
      return ctext ? `${labelParts}: "${ctext}"` : labelParts
    })

  const lines = [
    `tag: ${tag}`,
    role ? `role: ${role}` : null,
    ariaLabel ? `ariaLabel: ${ariaLabel}` : null,
    truncatedText ? `text: ${truncatedText}` : null,
    childrenSummary.length > 0 ? `children: [${childrenSummary.join(', ')}]` : null,
  ].filter((l): l is string => l !== null)

  return lines.join('\n')
}
