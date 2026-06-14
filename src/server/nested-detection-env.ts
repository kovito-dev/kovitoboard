/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Nested-detection environment scrubbing — single source of truth for the
 * key-classification predicate shared by every path that strips
 * Claude Code's nested-instance signal vars before launching a `claude`
 * child.
 *
 * Spec SSOT: `session-management.md` §8.9 (nested-detection scrub).
 *
 * Why we strip these: when KovitoBoard is itself launched from inside a
 * Claude Code session (the typical "ask an agent to start KB" flow), the
 * supervisor's `process.env` carries Claude Code's nested-detection
 * signal vars. If those vars reach a `claude` child that KB spawns
 * (one-shot) or launches via tmux (interactive), the child mistakes
 * itself for a nested instance and refuses to write its top-level
 * project transcript — so the KB UI shows nothing and no error surfaces
 * (silent failure).
 *
 * What we DO NOT strip: `ANTHROPIC_API_KEY` and other `ANTHROPIC_*` vars
 * are the operator's authentication / endpoint configuration. Removing
 * them would break authentication for the child `claude` (§8.9.2). The
 * predicate below is deliberately narrow: the exact names `CLAUDECODE` /
 * `AI_AGENT` plus the `CLAUDE_CODE_` prefix only. Unrelated `CLAUDE*`
 * vars (e.g. `CLAUDE_EFFORT`) are intentionally left untouched.
 *
 * DRY boundary (§8.9.3): the shared SSOT is this predicate + the
 * `ANTHROPIC_*` preservation rule, NOT a monolithic scrub helper. The
 * two `process.env` object-filtering paths (one-shot in `claude-bridge`
 * and the server early-init scrub in `index.ts`) share
 * `scrubNestedDetectionEnv`. The tmux path is transport-specific
 * (`show-environment` enumeration + `set-environment -r`) and reuses
 * only the predicate, not this helper.
 *
 * Note: the supervisor (`tools/kb-start.mjs`) is a separate `node`
 * runtime that cannot import this TypeScript module without a build
 * step, so it carries a small inline copy of the predicate. Keep the
 * two in sync — this file is the canonical definition.
 */

/**
 * Returns `true` when `key` is one of Claude Code's nested-instance
 * detection signal vars that must be stripped before launching a child
 * `claude`. `CLAUDE_CODE_` is a prefix match so future
 * `CLAUDE_CODE_*` vars are covered automatically.
 */
export function isNestedDetectionKey(key: string): boolean {
  return key === 'CLAUDECODE' || key === 'AI_AGENT' || key.startsWith('CLAUDE_CODE_')
}

/**
 * Returns a shallow copy of `env` with every nested-detection key
 * removed. `ANTHROPIC_*` and all other vars are preserved. Pure object
 * filter — never throws, never mutates the input.
 *
 * Used by the two `process.env`-transport paths: the one-shot
 * `ClaudeBridge.spawnClaude` (§7.1.1) and the server early-init scrub
 * (`index.ts` startup step 0, §5.3). The tmux path does not use this
 * helper (see module doc).
 */
export function scrubNestedDetectionEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(env)) {
    if (!isNestedDetectionKey(key)) {
      scrubbed[key] = env[key]
    }
  }
  return scrubbed
}
