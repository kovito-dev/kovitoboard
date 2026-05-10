/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Tests for the ambient sidebar's a11y DOM walker (DEC-020 / EU8 Phase 4).
 *
 * jsdom is sufficient: the walker only relies on `Element.tagName`,
 * `getAttribute`, `getBoundingClientRect`, and basic DOM traversal.
 * `Element.computedRole` is intentionally not used (jsdom-incompatible),
 * which is why we built a custom walker in the first place.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureAccessibilitySnapshot,
  MAX_SNAPSHOT_BYTES,
} from '../../src/renderer/lib/accessibility-snapshot'

/**
 * jsdom returns `0`-sized rects for everything by default. The walker's
 * viewport filter would then reject every node, so we monkey-patch
 * getBoundingClientRect for the duration of the test to return a
 * non-zero rect that intersects the viewport.
 */
function stubBoundingRectsToVisible(): void {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 110,
        width: 100,
        height: 100,
        toJSON: () => ({}),
      }
    },
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
}

describe('accessibility-snapshot', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    stubBoundingRectsToVisible()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('emits a plain-text role outline (no fence wrapper)', () => {
    // The previous ` ```a11y ` fence was dropped in the K-15 cutover
    // (spec `kb-authored-sentinel.md` §11.3) — the rule-line sentinel
    // applied by `AmbientSidebar.composePayload` carries the kind
    // identifier instead, so this function returns plain indented
    // role lines.
    document.body.innerHTML = '<h1>Reports</h1><a href="#">Open</a>'
    const result = captureAccessibilitySnapshot()
    expect(result).not.toBeNull()
    if (!result) throw new Error('result is null')
    expect(result.block).not.toContain('```')
    expect(result.block).toMatch(/heading\[level=1\]: "Reports"/)
    expect(result.block).toMatch(/link: "Open"/)
  })

  it('includes role + name for headings, links, and buttons', () => {
    document.body.innerHTML = `
      <h1>Reports</h1>
      <a href="#x">Open</a>
      <button>Run</button>
    `
    const result = captureAccessibilitySnapshot()
    if (!result) throw new Error('result is null')
    expect(result.block).toMatch(/heading\[level=1\]: "Reports"/)
    expect(result.block).toMatch(/link: "Open"/)
    expect(result.block).toMatch(/button: "Run"/)
    expect(result.nodeCount).toBeGreaterThanOrEqual(3)
  })

  it('honors aria-label over text content', () => {
    document.body.innerHTML = '<button aria-label="Confirm purchase">OK</button>'
    const result = captureAccessibilitySnapshot()
    if (!result) throw new Error('result is null')
    expect(result.block).toMatch(/button: "Confirm purchase"/)
  })

  it('reports truncated=true when output exceeds the cap', () => {
    // ~200 buttons each with a unique long label.
    const longLabel = 'x'.repeat(80)
    const buttons = Array.from({ length: 200 }, (_, i) => `<button>${longLabel}-${i}</button>`).join('')
    document.body.innerHTML = buttons
    // Tighten the cap so we hit it deterministically.
    const result = captureAccessibilitySnapshot({ maxBytes: 1_000 })
    if (!result) throw new Error('result is null')
    expect(result.truncated).toBe(true)
    // The output respects the cap.
    expect(result.block.length).toBeLessThanOrEqual(1_000)
  })

  it('skips SCRIPT and STYLE subtrees', () => {
    document.body.innerHTML = `
      <h1>Title</h1>
      <script>console.log("hi")</script>
      <style>.x { color: red }</style>
    `
    const result = captureAccessibilitySnapshot()
    if (!result) throw new Error('result is null')
    expect(result.block).toMatch(/heading\[level=1\]: "Title"/)
    expect(result.block).not.toMatch(/console\.log/)
    expect(result.block).not.toMatch(/color: red/)
  })

  it('returns a non-null result with elapsedMs >= 0 for an empty body', () => {
    const result = captureAccessibilitySnapshot()
    expect(result).not.toBeNull()
    if (!result) throw new Error('result is null')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('default cap matches the spec (50,000)', () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(50_000)
  })
})
