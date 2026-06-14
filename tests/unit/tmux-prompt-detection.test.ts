/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * `waitForPrompt` input-prompt readiness detection (pure core).
 *
 * Pins the Claude Code 2.1.177 TUI follow-up (session-management.md
 * v1.5 §7.2): the caret line sits above a status line + multi-agent
 * footer, so the legacy 3-line window / `includes('❯')` test broke.
 * These tests exercise the extracted pure helpers against real-shaped
 * capture frames:
 *
 *   - Primary path      : input-box caret + footer marker
 *   - Stability fallback: caret + volatile-stripped window held still
 *   - Trust prompt      : trust footer keeps "not ready"
 *   - Processing spinner : `✻ …` keeps "not ready"
 *   - Volatile timer     : `🤖 … ⏱ …` stripped only from stability
 */
import { describe, it, expect } from 'vitest'
import {
  sampleWindow,
  stabilityString,
  hasInputBoxCaret,
  hasProcessingMarker,
  evaluatePromptFrame,
  PROMPT_SAMPLE_LINES,
  PROMPT_CAPTURE_START,
} from '../../src/server/tmux-bridge'

// A ready 2.1.177 idle prompt: labelled top border, caret, bottom
// border, live status line, multi-agent footer (handoff fixture shape).
const READY_2_1_177 = [
  '─────────────── chief ──',
  '❯',
  '────────────────────────',
  '  🤖 kovito-concierge | Sonnet 4.6 | Ctx -- | ⚡xhigh | ⏱ 0m40s | ⏳ 5h …',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

// Same prompt one second later — only the elapsed timer advanced.
const READY_2_1_177_TICK = [
  '─────────────── chief ──',
  '❯',
  '────────────────────────',
  '  🤖 kovito-concierge | Sonnet 4.6 | Ctx -- | ⚡xhigh | ⏱ 0m41s | ⏳ 5h …',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

// Busy pane: randomized-gerund spinner with the `esc to interrupt` hint.
const PROCESSING_2_1_177 = [
  '─────────────── chief ──',
  '❯',
  '────────────────────────',
  '✻ Hyperspacing… (1m 26s · esc to interrupt)',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

// Folder-trust dialog: menu cursor `❯` + "Enter to confirm · Esc to cancel".
const TRUST_PROMPT = [
  '╭──────────────────────────────────────╮',
  '│ Do you trust the files in this folder? │',
  '│  ❯ 1. Yes, proceed                     │',
  '│    2. No, exit                         │',
  '╰──────────────────────────────────────╯',
  '   Enter to confirm · Esc to cancel',
].join('\n')

describe('sampleWindow', () => {
  it('drops empty lines and keeps the trailing window', () => {
    const cap = ['a', '', '  ', 'b', 'c', '', 'd'].join('\n')
    expect(sampleWindow(cap)).toEqual(['a', 'b', 'c', 'd'])
  })

  it(`keeps at most ${PROMPT_SAMPLE_LINES} lines`, () => {
    const cap = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const w = sampleWindow(cap)
    expect(w).toHaveLength(PROMPT_SAMPLE_LINES)
    expect(w[w.length - 1]).toBe('line19')
  })

  it('keeps the 2.1.177 caret line inside the window (regression)', () => {
    const w = sampleWindow(READY_2_1_177)
    expect(hasInputBoxCaret(w)).toBe(true)
  })

  it('captures wider than the logical window to absorb blank rows', () => {
    // `capture-pane -S` must grab more *physical* rows than the
    // logical sample window, so blank spacer rows below the input box
    // cannot shrink the non-empty window below PROMPT_SAMPLE_LINES and
    // push the caret out of view (codex review attempt 3 regression).
    expect(PROMPT_CAPTURE_START).toBeLessThanOrEqual(-(PROMPT_SAMPLE_LINES * 2))
  })

  it('keeps the caret in view despite blank spacer rows below the box', () => {
    // Simulate a `capture-pane -S -16` window where the chrome below the
    // input box interleaves blank spacer rows. After dropping blanks,
    // the trailing PROMPT_SAMPLE_LINES window must still hold the
    // caret/border pair.
    const physical = [
      'older scrollback line a',
      'older scrollback line b',
      '',
      '─────────────── chief ──',
      '❯',
      '────────────────────────',
      '',
      '  🤖 kovito-concierge | Sonnet 4.6 | ⏱ 0m40s | ⏳ 5h …',
      '',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    expect(hasInputBoxCaret(sampleWindow(physical))).toBe(true)
  })
})

describe('hasInputBoxCaret', () => {
  it('accepts a lone caret bounded by a labelled top border', () => {
    expect(hasInputBoxCaret(sampleWindow(READY_2_1_177))).toBe(true)
  })

  it('accepts a caret framed by box-char side borders', () => {
    expect(hasInputBoxCaret(['╭───╮', '│ ❯ │', '╰───╯'])).toBe(true)
  })

  it('accepts a labelled border with a hyphenated agent name', () => {
    // Agent IDs validate as [a-zA-Z0-9_-]; the hyphen must not break the
    // labelled-border recognition (e.g. `── kovito-concierge ──`).
    expect(
      hasInputBoxCaret([
        '────── kovito-concierge ──',
        '❯',
        '──────────────────────────',
      ]),
    ).toBe(true)
  })

  it('rejects a `❯` that is a trust-menu cursor (not a lone caret)', () => {
    expect(hasInputBoxCaret(sampleWindow(TRUST_PROMPT))).toBe(false)
  })

  it('rejects a caret with no adjacent input-box boundary', () => {
    expect(hasInputBoxCaret(['some text', '❯', 'more text'])).toBe(false)
  })

  it('rejects `❯` embedded in an activity line', () => {
    expect(
      hasInputBoxCaret(['────────', '❯ running step 3 of 5', '────────']),
    ).toBe(false)
  })
})

describe('stabilityString', () => {
  it('strips the volatile `🤖 … ⏱ …` status line', () => {
    const s = stabilityString(sampleWindow(READY_2_1_177))
    expect(s).not.toContain('🤖')
    expect(s).toContain('❯')
    expect(s).toContain('← for agents')
  })

  it('is identical across a live-timer tick (stability can settle)', () => {
    expect(stabilityString(sampleWindow(READY_2_1_177))).toBe(
      stabilityString(sampleWindow(READY_2_1_177_TICK)),
    )
  })
})

describe('hasProcessingMarker', () => {
  it('matches a live spinner line (glyph + ellipsis)', () => {
    expect(hasProcessingMarker(['✻ Hyperspacing… (1m 26s)'])).toBe(true)
    expect(hasProcessingMarker(['✢ Transfiguring… (thinking)'])).toBe(true)
  })

  it('matches a live spinner line (glyph + esc to interrupt)', () => {
    expect(
      hasProcessingMarker(['✻ Hyperspacing (1m 26s · esc to interrupt)']),
    ).toBe(true)
  })

  it('matches the legacy processing markers', () => {
    expect(hasProcessingMarker(['Running…'])).toBe(true)
    expect(hasProcessingMarker(['(streaming response)'])).toBe(true)
  })

  it('does NOT match a settled past-tense activity line (no live signal)', () => {
    // `✻ Brewed for 7s` / `✻ Sautéed for 9s` can linger in the sampled
    // window after the turn ends. With no ellipsis and no interrupt hint
    // these are settled lines, NOT live spinners — matching them would
    // wrongly keep a ready prompt "processing" until they scroll out.
    expect(hasProcessingMarker(['✻ Brewed for 7s'])).toBe(false)
    expect(hasProcessingMarker(['✻ Sautéed for 9s'])).toBe(false)
    expect(hasProcessingMarker(['plain text with ✻ glyph inline'])).toBe(false)
  })
})

describe('evaluatePromptFrame', () => {
  it('Primary: ready via footer marker on the 2.1.177 prompt', () => {
    const d = evaluatePromptFrame(sampleWindow(READY_2_1_177), false)
    expect(d).toEqual({ ready: true, via: 'primary' })
  })

  it('Stability fallback: caret + held still, no footer marker', () => {
    // A prompt whose footer wording is unknown but caret + stability hold.
    const w = ['────────', '❯', '────────', '  (unknown footer wording)']
    expect(evaluatePromptFrame(w, false)).toEqual({
      ready: false,
      reason: 'unstable',
    })
    expect(evaluatePromptFrame(w, true)).toEqual({
      ready: true,
      via: 'stability',
    })
  })

  it('Trust prompt: never ready even though a `❯` is present', () => {
    expect(evaluatePromptFrame(sampleWindow(TRUST_PROMPT), true)).toEqual({
      ready: false,
      reason: 'no-caret',
    })
  })

  it('Processing spinner: never ready (✻ anchor) even with caret + footer', () => {
    expect(evaluatePromptFrame(sampleWindow(PROCESSING_2_1_177), true)).toEqual({
      ready: false,
      reason: 'processing',
    })
  })

  it('no caret → not ready', () => {
    const w = ['────────', '────────', '  footer Enter to confirm']
    expect(evaluatePromptFrame(w, true)).toEqual({
      ready: false,
      reason: 'no-caret',
    })
  })

  it('ready prompt with a lingering settled activity line stays ready', () => {
    // A completed `✻ Brewed for 7s` line can remain above the input box;
    // it must not block readiness (over-broad processing regression).
    const w = [
      '✻ Brewed for 7s',
      '─────────────── chief ──',
      '❯',
      '────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ]
    expect(evaluatePromptFrame(w, false)).toEqual({
      ready: true,
      via: 'primary',
    })
  })

  it('does NOT treat a ready footer `Esc to interrupt` as processing', () => {
    // The legacy ready footer can carry "Esc to interrupt"; the spinner
    // anchor (✻/✢) is what marks "processing", so this stays ready.
    const w = ['────────', '❯', '────────', '  Esc to interrupt']
    expect(evaluatePromptFrame(w, false)).toEqual({
      ready: true,
      via: 'primary',
    })
  })
})
