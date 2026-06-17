/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the `multi-question-unsupported` server-side handling
 * (BL-2026-263 Phase A).
 *
 * Spec: `docs/specs/trust-prompt-relay.md` v1.8 §7.8.4 / §7.8.5 / §10.7.6.
 *
 * Covers the data path the WS gate (`handleTrustPromptRespond` in
 * `index.ts`) depends on:
 *
 *   - The detector retains the matched kind per window and exposes it via
 *     `getPendingPromptKind(windowName, promptId)` (the predicate the gate
 *     uses to enforce the response restriction, §10.7.6 plan A).
 *   - A `multi-question-unsupported` prompt is broadcast as
 *     `trust_prompt_detected` with `choices: []` (§7.8.4).
 *   - `respondChoice` cannot reach tmux for this kind (empty choices), and
 *     the canonical ESC raw-keys IS delivered while any other value is the
 *     gate's responsibility to reject — proven structurally by the kind
 *     lookup returning the unsupported kind.
 *   - Reconnect replay re-emits the kind with `choices: []` (§7.8.4 / §9.5-6).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The detector (and its paths.ts dependency) logs via trustLogger /
// lazyChildLogger. Stub the logger module so respondChoice / respondRawKeys
// do not require a real root logger (which would write to .kovitoboard/logs).
// `vi.hoisted` makes the stub available to the hoisted `vi.mock` factory.
const loggerStub = vi.hoisted(() => {
  const stub = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  return stub
})
vi.mock('../../src/server/logger', () => ({
  trustLogger: loggerStub,
  lazyChildLogger: () => loggerStub,
}))

import {
  TrustPromptDetector,
  loadTrustPatterns,
  POLL_INTERVAL_MS,
  type BroadcastFn,
} from '../../src/server/trust-prompt-detector'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { CANONICAL_ESC_RAW_KEYS } from '../../src/shared/ws-events'
import type { ServerToClientEvent } from '../../src/shared/ws-events'
import type { TmuxBridge, TmuxWindow } from '../../src/server/tmux-bridge'

const PATTERNS_JSON = join(__dirname, '../../src/server/trust-patterns.json')
const FIXTURE = join(
  __dirname,
  '../fixtures/trust-prompts/claude-2.1.126/multi-question-form.txt',
)

const WINDOW = 'kovito-concierge'

/**
 * Minimal fake TmuxBridge exposing only the methods the detector calls.
 * `sendTrustPromptKeys` records every invocation so we can assert it is
 * never reached for a rejected response.
 */
class FakeTmux {
  capture: string
  sendCalls: Array<{ windowName: string; keys: string; literal: boolean }> = []

  constructor(capture: string) {
    this.capture = capture
  }

  hasSession(): boolean {
    return true
  }

  listWindows(): TmuxWindow[] {
    return [{ index: 1, name: WINDOW, active: true }]
  }

  capturePane(_windowName: string, _lines?: number): string | null {
    return this.capture
  }

  sendTrustPromptKeys(windowName: string, keys: string, literal = false): boolean {
    this.sendCalls.push({ windowName, keys, literal })
    return true
  }
}

function makeDetector(capture: string): {
  detector: TrustPromptDetector
  tmux: FakeTmux
  events: ServerToClientEvent[]
} {
  const fs = new DirectFsLayer()
  const config = loadTrustPatterns(fs, PATTERNS_JSON)
  const tmux = new FakeTmux(capture)
  const events: ServerToClientEvent[] = []
  const broadcast: BroadcastFn = (e) => events.push(e)
  const detector = new TrustPromptDetector(
    tmux as unknown as TmuxBridge,
    config.patterns,
    broadcast,
    fs,
  )
  return { detector, tmux, events }
}

/**
 * Drive enough ticks for the idle counter to confirm and the prompt to
 * fire. POLL_INTERVAL_MS is irrelevant here because we call the private
 * tick loop indirectly via start()/stop() with fake timers would be
 * heavier — instead we run the detector loop manually by repeatedly
 * invoking the public detection through start() and a short real wait is
 * avoided by directly exercising the loop. We use the detector's own
 * loop by starting it and pumping ticks synchronously.
 */
function pumpDetection(detector: TrustPromptDetector): void {
  // refreshWindows + several ticks. The detector exposes no synchronous
  // tick, so we start the timer-based loop and immediately stop after
  // letting it run a few intervals via the test's fake clock is overkill;
  // instead reach into the loop deterministically by calling the same
  // sequence the loop uses. `start()` runs refreshWindows() immediately,
  // then we trigger detection by invoking the private tick a few times.
  // @ts-expect-error access private for deterministic test driving
  detector.refreshWindows()
  for (let i = 0; i < 5; i++) {
    // @ts-expect-error access private for deterministic test driving
    detector.tick()
  }
}

describe('multi-question-unsupported server handling (BL-2026-263 Phase A)', () => {
  let capture: string

  beforeEach(() => {
    capture = readFileSync(FIXTURE, 'utf-8')
  })

  it('§7.8.4: broadcasts trust_prompt_detected with the kind and empty choices', () => {
    const { detector, events } = makeDetector(capture)
    pumpDetection(detector)
    detector.stop()

    const detected = events.find((e) => e.type === 'trust_prompt_detected')
    expect(detected, 'a trust_prompt_detected event should fire').toBeDefined()
    if (detected && detected.type === 'trust_prompt_detected') {
      expect(detected.payload.kind).toBe('multi-question-unsupported')
      expect(detected.payload.choices).toEqual([])
      expect(detected.payload.windowName).toBe(WINDOW)
    }
  })

  it('§10.7.6: getPendingPromptKind returns the kind for the pending prompt', () => {
    const { detector, events } = makeDetector(capture)
    pumpDetection(detector)

    const detected = events.find((e) => e.type === 'trust_prompt_detected')
    expect(detected?.type).toBe('trust_prompt_detected')
    const promptId =
      detected?.type === 'trust_prompt_detected' ? detected.payload.promptId : ''
    expect(promptId).not.toBe('')

    expect(detector.getPendingPromptKind(WINDOW, promptId)).toBe(
      'multi-question-unsupported',
    )
    // Unknown promptId / window → null (the gate then treats it as a normal
    // prompt and falls through to its default handling).
    expect(detector.getPendingPromptKind(WINDOW, 'no-such-id')).toBeNull()
    expect(detector.getPendingPromptKind('no-such-window', promptId)).toBeNull()
    detector.stop()
  })

  it('§7.8.5: respondChoice never reaches tmux for this kind (empty choices)', () => {
    const { detector, tmux, events } = makeDetector(capture)
    pumpDetection(detector)
    const detected = events.find((e) => e.type === 'trust_prompt_detected')
    const promptId =
      detected?.type === 'trust_prompt_detected' ? detected.payload.promptId : ''

    // Even if a forged client bypassed the gate, the detector cannot
    // resolve any choiceId for a kind whose choices are [].
    const ok = detector.respondChoice(WINDOW, promptId, 'yes')
    expect(ok).toBe(false)
    expect(tmux.sendCalls).toHaveLength(0)
    detector.stop()
  })

  it('§7.8.6: the canonical ESC raw-keys reaches tmux in literal mode', () => {
    const { detector, tmux, events } = makeDetector(capture)
    pumpDetection(detector)
    const detected = events.find((e) => e.type === 'trust_prompt_detected')
    const promptId =
      detected?.type === 'trust_prompt_detected' ? detected.payload.promptId : ''

    const ok = detector.respondRawKeys(WINDOW, promptId, CANONICAL_ESC_RAW_KEYS)
    expect(ok).toBe(true)
    expect(tmux.sendCalls).toHaveLength(1)
    expect(tmux.sendCalls[0].keys).toBe(CANONICAL_ESC_RAW_KEYS)
    expect(tmux.sendCalls[0].literal).toBe(true)
    detector.stop()
  })

  it('§9.5-6: reconnect replay re-emits the kind with empty choices', () => {
    const { detector } = makeDetector(capture)
    pumpDetection(detector)

    const replay = detector.getPendingPrompts()
    expect(replay).toHaveLength(1)
    const ev = replay[0]
    expect(ev.type).toBe('trust_prompt_detected')
    if (ev.type === 'trust_prompt_detected') {
      expect(ev.payload.kind).toBe('multi-question-unsupported')
      expect(ev.payload.choices).toEqual([])
    }
    detector.stop()
  })

  it('POLL_INTERVAL_MS is defined (loop config sanity)', () => {
    expect(POLL_INTERVAL_MS).toBeGreaterThan(0)
  })
})
