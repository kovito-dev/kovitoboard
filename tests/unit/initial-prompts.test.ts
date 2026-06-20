/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the initial-prompt dictionary
 * (`src/server/services/initial-prompts.ts`).
 *
 * The `security:add-deny-pattern` key backs the "ask an agent to fix
 * this" button on the SecurityRecommendationsToast. It must resolve a
 * non-empty, locale-aware prompt for both `ja` and `en` so the server's
 * `/api/sessions/new` initialPrompt path can prefill the remediation
 * message.
 */
import { describe, expect, it } from 'vitest'
import { getInitialPrompt } from '../../src/server/services/initial-prompts'

describe('getInitialPrompt', () => {
  it('resolves the security:add-deny-pattern prompt for ja', () => {
    const prompt = getInitialPrompt('security:add-deny-pattern', 'ja')
    expect(prompt).toBeTruthy()
    expect(typeof prompt).toBe('string')
    // The prompt must mention the directory the user is asked to deny.
    expect(prompt).toContain('.kovitoboard/')
    // ja-specific marker so a locale mix-up is caught.
    expect(prompt).toContain('Claude Code')
    expect(prompt).toContain('permissions.deny')
  })

  it('resolves the security:add-deny-pattern prompt for en', () => {
    const prompt = getInitialPrompt('security:add-deny-pattern', 'en')
    expect(prompt).toBeTruthy()
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('.kovitoboard/')
    expect(prompt).toContain('deny pattern')
    expect(prompt).toContain('permissions.deny')
  })

  it('returns distinct ja and en text for security:add-deny-pattern', () => {
    const ja = getInitialPrompt('security:add-deny-pattern', 'ja')
    const en = getInitialPrompt('security:add-deny-pattern', 'en')
    expect(ja).not.toBe(en)
  })

  it('still resolves the onboarding:first-time prompt (regression)', () => {
    expect(getInitialPrompt('onboarding:first-time', 'ja')).toBeTruthy()
    expect(getInitialPrompt('onboarding:first-time', 'en')).toBeTruthy()
  })

  it('returns null for an unknown key', () => {
    expect(getInitialPrompt('does:not-exist', 'en')).toBeNull()
  })

  // The deny-pattern checker (`denyCoversKovitoboard`) rejects
  // action-scoped wrappers like `Read(.kovitoboard/**)` because they
  // only block one action class. If the remediation prompt suggested
  // that form, an agent following the example would write a config that
  // KB's own checker still flags — the toast would never clear. Pin the
  // prompt examples to a form the checker accepts.
  it.each(['ja', 'en'] as const)(
    'security:add-deny-pattern (%s) does not suggest an action-scoped deny entry',
    (locale) => {
      const prompt = getInitialPrompt('security:add-deny-pattern', locale)!
      // The action-scoped form `<Action>(...)` must not appear inside a
      // JSON deny array example.
      expect(prompt).not.toMatch(/"deny":\s*\[\s*"[A-Za-z][A-Za-z0-9_-]*\(/)
      // The accepted whole-tree form must be present in the example.
      expect(prompt).toContain('".kovitoboard/**"')
    },
  )

  // `.claude/settings.json` is a sensitive config file. The prompt must
  // tell the agent to preserve the rest of the file rather than replace
  // it with the minimal example (which would drop existing allow/deny,
  // hooks, or env settings).
  it('security:add-deny-pattern (en) tells the agent to preserve existing settings', () => {
    const prompt = getInitialPrompt('security:add-deny-pattern', 'en')!
    expect(prompt).toMatch(/preserve/i)
    expect(prompt).toMatch(/do not replace the whole file/i)
  })
})
