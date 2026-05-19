/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Logic-level coverage for the StepSecurity 4-state reset contract
 * defined by `onboarding-scenarios.md` v1.6 §9.5.2.3 exception
 * clause 2.
 *
 * The spec §9.5.6 Test 6 mandates a unit test that prevents a state-
 * carry-over escape of the bypass-mode T-4-1 / T-4-2 / I-6 gate: if
 * `handleRecheck` ever dropped one of the four reset fields, a user
 * could re-enter the violation path on a fresh settings-check with a
 * pre-ticked acknowledge / pre-satisfied modal+idle gate left over
 * from the prior session — defeating the whole rubber-stamp
 * prevention design.
 *
 * Implementation choice: rather than adding `@testing-library/react`
 * (jsdom-free `tests/unit/` is the established convention here), we
 * lift the reset contract into the pure `createStepSecurityResetState`
 * factory exported from StepSecurity.tsx. The factory IS the single
 * source of truth `handleRecheck` consumes, so asserting its shape
 * pins the contract against silent drift. The user-visible re-arm
 * (Recheck → bypass `disabled` again, Next `disabled` again) lives
 * in the L1 E2E coverage as a black-box complement.
 */
import { describe, expect, it } from 'vitest'
import { createStepSecurityResetState } from '../../src/renderer/pages/onboarding/StepSecurity'

describe('createStepSecurityResetState (spec v1.6 §9.5.2.3 4-state reset)', () => {
  it('zeroes all three per-row acknowledgements', () => {
    const reset = createStepSecurityResetState()
    expect(reset.acknowledged).toEqual({
      permissionMode: false,
      denyPattern: false,
      bypassMode: false,
    })
  })

  it('resets ruleOfTwoEverOpened to false (T-4-2 / I-6 modal-prerequisite re-arms)', () => {
    const reset = createStepSecurityResetState()
    expect(reset.ruleOfTwoEverOpened).toBe(false)
  })

  it('resets ruleOfTwoClosedAt to null (T-4-2 idle timer disarms)', () => {
    const reset = createStepSecurityResetState()
    expect(reset.ruleOfTwoClosedAt).toBeNull()
  })

  it('resets whyOpen to null (no modal lingers across a recheck)', () => {
    const reset = createStepSecurityResetState()
    expect(reset.whyOpen).toBeNull()
  })

  it('returns a fresh object on each call (no shared reference)', () => {
    // Defensive: if the factory ever started returning a frozen
    // singleton or a memoised handle, a future `setAcknowledged(...)`
    // call inside `handleRecheck` could mutate the canonical reset
    // shape and silently degrade subsequent rechecks. The contract
    // is `() => new object`.
    const a = createStepSecurityResetState()
    const b = createStepSecurityResetState()
    expect(a).not.toBe(b)
    expect(a.acknowledged).not.toBe(b.acknowledged)
  })

  it('exposes exactly the four reset fields the spec names', () => {
    // The shape assertion guards against accidental field
    // additions (which would silently bypass the spec's 4-state
    // closure) and deletions (which would re-introduce the escape
    // the v1.6 amendment was written to seal). If the spec ever
    // adds or removes a reset field, this test must be updated in
    // the same PR as the spec change.
    const reset = createStepSecurityResetState()
    expect(Object.keys(reset).sort()).toEqual(
      ['acknowledged', 'ruleOfTwoClosedAt', 'ruleOfTwoEverOpened', 'whyOpen'].sort(),
    )
  })
})
