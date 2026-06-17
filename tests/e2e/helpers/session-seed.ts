/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Session Seed Helper — surface a real watched session in L1 without a
 * live Claude process.
 *
 * Background
 * ----------
 * In L1 the Fake Claude harness only paints tmux panes (for the
 * trust-prompt detector); it never writes the Claude Code transcript
 * JSONL that the Watcher reads. Yet a session only appears in
 * `GET /api/sessions` / the renderer session list once the Watcher
 * observes a `<sessionId>.jsonl` file under the project's Claude
 * sessions directory and feeds its events into the SessionManager
 * (which is the sole origin of the `new_session` / `new_event` /
 * `status_change` WebSocket events the renderer reacts to).
 *
 * This helper closes that gap deterministically: it writes (and later
 * appends to) a transcript JSONL exactly where the Watcher looks, so a
 * test can:
 *   1. surface a session (seed an initial completed turn), and
 *   2. simulate Claude appending a reply to the SAME session (append a
 *      live assistant line) — the exact event flow the idle-send
 *      regression depends on.
 *
 * Watched directory
 * -----------------
 * The Watcher reads `<claudeDir>/projects/<encoded-projectRoot>/*.jsonl`
 * where `claudeDir` is `$HOME/.claude` (no env override exists) and the
 * encoding is `projectRoot.replace(/\//g, '-')`
 * (see src/server/watcher.ts `projectPathToClaudeDirName`). The seeded
 * file therefore lives under the host's real `~/.claude/projects/...`,
 * namespaced by the unique template-cache project root, so it does NOT
 * collide with the developer's real Claude sessions. It is OUTSIDE the
 * per-test `.kovitoboard/` snapshot/restore, so callers MUST invoke
 * `dispose()` (or use the returned handle in a `finally`) to remove it.
 *
 * Live vs historical (important: the OPENING turn's status is NOT
 * deterministic)
 * --------------------------------------------------------------------
 * The Watcher treats a file's pre-existing-on-first-observation bytes as
 * "historical" (status is held) and only genuinely-live appends update
 * `status` (watcher.ts INV-2). `seedSession()` writes the file empty first
 * so that — IF the Watcher happens to observe it at size 0 before any
 * content is appended — the opening turn reads as a live status transition.
 * But this is a best-effort ordering, NOT a guarantee: the empty write and
 * the opening append happen back-to-back, so the Watcher's ~1.5s poll may
 * first see the file only after content already exists, in which case the
 * opening turn is historical and the session surfaces at `idle`.
 *
 * Therefore callers MUST NOT rely on the opening turn's status. Drive the
 * target status explicitly AFTER the session is visible in the API (at
 * which point the file's offset is committed and `restoringFiles` has been
 * cleared, so EVERY further append is guaranteed live, watcher.ts INV-2):
 *   - idle  → `POST /api/agents/<id>/deactivate-sessions` (deterministic).
 *   - ready → `appendAssistantReply(...)` then wait for `status === 'ready'`.
 * The idle-send spec follows exactly this pattern.
 */
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readdirSync,
  rmdirSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** Mirror of src/server/watcher.ts `projectPathToClaudeDirName`. */
function encodeProjectRoot(projectRoot: string): string {
  return projectRoot.replace(/\//g, '-')
}

/**
 * Conservative whitelist for an explicit session id. A real Claude session
 * id is a UUID; this allows that plus the `l1-...` test prefix shape while
 * forbidding path separators and `..`. The id is interpolated into a path
 * that is both written and later `rmSync`'d under the host's real
 * `~/.claude/projects/`, so a `../../` value could escape that directory —
 * reject it up front and additionally assert containment below.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

/** Resolve the directory the Watcher scans for this project's sessions. */
function watchedSessionsDir(projectRoot: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectRoot(projectRoot))
}

export interface SeededSession {
  /** The session id (also the JSONL filename stem). */
  sessionId: string
  /** Absolute path to the seeded transcript JSONL. */
  filePath: string
  /**
   * Append an assistant reply line as a LIVE event so the Watcher emits a
   * `new_event` for this session and a `status_change`. This simulates
   * Claude streaming a response into the SAME session.
   */
  appendAssistantReply(text: string): void
  /** Append a user-turn line (e.g. to mirror the message just sent). */
  appendUserTurn(text: string): void
  /** Remove the seeded JSONL file. Idempotent. */
  dispose(): void
}

/**
 * An `agent-setting` line. Claude Code emits this on process launch when
 * `--agent <id>` is passed; the Watcher reads `raw.agentSetting` and binds
 * the session to that agent (watcher.ts) BEFORE any message event, so the
 * `new_session` summary carries `agentId` and the renderer populates its
 * `sessionAgentMap` immediately over the same WebSocket burst (no stale
 * map / no extra REST round-trip the test would have to race). `parseLine`
 * produces no event for this type, so it does not itself surface the
 * session.
 */
function agentSettingLine(agentId: string): string {
  return JSON.stringify({
    type: 'agent-setting',
    timestamp: new Date().toISOString(),
    agentSetting: agentId,
  })
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

/**
 * An assistant turn that ends the response (`stop_reason: 'end_turn'`),
 * which SessionManager maps to the `ready` status — i.e. the response is
 * complete and the session is awaiting the next input. This is the shape
 * a real Claude reply lands as.
 */
function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  })
}

/**
 * Seed a session into the Watcher's view.
 *
 * @param projectRoot  the project root the L1 webServer was started with
 *                     (kbFixture.projectRoot). Used to compute the
 *                     watched sessions directory.
 * @param opts.agentId   when set, an `agent-setting` line is written first
 *                     so the session is bound to this agent (and the
 *                     renderer's sessionAgentMap is populated via the
 *                     `new_session` summary). Pair this with a tmux window
 *                     whose name equals `agentId` (helpers/idle-agent-window.ts)
 *                     to make the idle session "sendable" (MessageInput
 *                     rendered).
 * @param opts.openingUser     opening user-turn text (default a fixed string)
 * @param opts.openingAssistant opening assistant reply text that completes
 *                     the first turn so the session has visible history.
 * @param opts.sessionId optional explicit session id; a random one is
 *                     generated by default to avoid cross-test collisions.
 */
export function seedSession(
  projectRoot: string,
  opts: {
    agentId?: string
    openingUser?: string
    openingAssistant?: string
    sessionId?: string
  } = {},
): SeededSession {
  const sessionId =
    opts.sessionId ?? `l1-idle-${randomBytes(6).toString('hex')}`
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `[session-seed] sessionId must match ${SESSION_ID_RE} ` +
        `(got: ${JSON.stringify(sessionId)})`,
    )
  }
  const dir = watchedSessionsDir(projectRoot)
  const filePath = join(dir, `${sessionId}.jsonl`)
  // Defence in depth: even with the charset check above, assert the
  // resolved file path stays under the watched dir before any write/delete.
  const resolvedDir = resolve(dir)
  if (!resolve(filePath).startsWith(resolvedDir + sep)) {
    throw new Error(
      `[session-seed] refusing to seed outside the watched dir: ${filePath}`,
    )
  }

  mkdirSync(dir, { recursive: true })

  // Write the file empty first so that, IF the Watcher observes it at size 0
  // before the opening append lands, it records offset 0 and the opening
  // turn reads as live (watcher.ts INV-2). This is best-effort, not
  // guaranteed — see the "Live vs historical" note in the file header:
  // callers must drive the target status explicitly after the session is
  // visible in the API and never depend on the opening turn's status.
  writeFileSync(filePath, '')

  const append = (line: string) => appendFileSync(filePath, `${line}\n`)

  // Bind the agent first (silent: produces no event), so the subsequent
  // `new_session` summary carries the agentId.
  if (opts.agentId) {
    append(agentSettingLine(opts.agentId))
  }

  // Opening completed turn so the session surfaces with visible history.
  append(userLine(opts.openingUser ?? 'Opening message for the idle-send L1 regression.'))
  append(
    assistantLine(
      opts.openingAssistant ?? 'Opening reply that completes the first turn.',
    ),
  )

  return {
    sessionId,
    filePath,
    appendAssistantReply(text: string) {
      append(assistantLine(text))
    },
    appendUserTurn(text: string) {
      append(userLine(text))
    },
    dispose() {
      // Remove the seeded transcript. This directory lives under the host's
      // real `~/.claude/projects/` (see header), so cleanup is mandatory —
      // it is NOT covered by the per-test `.kovitoboard/` snapshot/restore.
      rmSync(filePath, { force: true })
      // Best-effort: drop the per-project sessions dir once it is empty so
      // repeated runs do not litter `~/.claude/projects/` with stale,
      // empty `-tmp-...-kb-e2e-template-...` directories. `rmdirSync` only
      // succeeds on an empty dir, so a concurrently-seeded sibling session
      // (same run, same project root) is never clobbered.
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir)
      } catch {
        /* dir non-empty, already gone, or in use — leave it. */
      }
    },
  }
}
