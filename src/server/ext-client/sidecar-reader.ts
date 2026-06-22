/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sidecar reader for the external-client launch-causality correlation
 * (external-client-api.md §7.3.2.1 (S-5), BL-2026-285 true closure).
 *
 * Why this exists
 * ---------------
 * The eager-claim narrowing (§7.3.2) excludes `'extension'` reservations
 * from the agentId-blind eager claim to close cross-path mis-ownership.
 * The cost is that an ext launch onto an *already-running* agent (the
 * `/clear` path, no `agent-setting` event) loses its correlation
 * (old R-5). To recover it WITHOUT re-introducing over-delivery, we read
 * the trusted signal Claude Code keeps per-PID at
 * `<claudeDir>/sessions/<pid>.json`:
 *
 *   { pid, sessionId, cwd, startedAt, procStart, agent, status,
 *     updatedAt, ... }
 *
 * The `agent` value equals the agentId KB passed to `claude --agent
 * <agentId>`, and `sessionId` is the process's CURRENT active session
 * (updated in place by `/clear`). The caller correlates these against
 * an in-flight ext launch (PID + sessionId + agent + transition + birth
 * identity, §7.3.2.1 (S-1)/(S-6)).
 *
 * Trust model
 * -----------
 * `<claudeDir>/sessions/` is a Claude Code internal (non-public) path:
 * its schema / path can change across versions. This reader is therefore
 * STRICTLY fail-closed — any absence / read failure / parse failure /
 * missing-or-wrong-typed field returns `null`, and the correlation caller
 * treats `null` as "skip the stamp" (under-delivery, never over-delivery;
 * no cwd-heuristic fallback, §7.3.2.1 (S-1') (c) / §10.4 R-5').
 *
 * SSOT
 * ----
 * The sidecar field names (`sessionId` / `agent` / `pid` / `procStart` /
 * `startedAt` / `updatedAt`) are read in exactly ONE place (this module)
 * so a Claude Code schema change has a single point of repair (§7.3.2.1
 * (S-5)).
 */
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'

/**
 * The subset of sidecar fields the launch-causality correlation needs.
 * All fields are validated to be present and correctly typed before a
 * `SidecarSnapshot` is returned; otherwise the reader returns `null`.
 */
export interface SidecarSnapshot {
  /** OS process id (echoes the filename `<pid>.json`). */
  pid: number
  /** The process's current active session (updated in place by `/clear`). */
  sessionId: string
  /**
   * The agentId from `claude --agent <agentId>`. `null` for a plain
   * `claude` launch (system-default agent), which KB never uses for an
   * ext launch — so a `null` agent never matches a launch's agentId.
   */
  agent: string | null
  /**
   * Process birth identity, used to reject PID reuse (§7.3.2.1 (S-6b)).
   * `procStart` is the `/proc/<pid>/stat` starttime (jiffies-since-boot,
   * stable for the life of the process); it is the preferred birth-id
   * because it can be cross-checked against `/proc`. `startedAt` (epoch
   * ms) is retained as a secondary signal.
   */
  procStart: string | null
  startedAt: number | null
  /** Last sidecar write time (epoch ms). Freshness signal. */
  updatedAt: number | null
}

/**
 * Read and validate the sidecar for `pid`. Returns a `SidecarSnapshot`
 * only when the file exists, parses as JSON, and carries a string
 * `sessionId` (the one field correlation cannot proceed without). Every
 * other field is best-effort: a missing / wrong-typed `agent` /
 * `procStart` / `startedAt` / `updatedAt` is normalised to `null` (the
 * caller's launch-causality checks then fail-closed on the `null`). Any
 * absence / read error / parse error / missing `sessionId` returns
 * `null` (fail-closed, §7.3.2.1 (S-1') (c)).
 *
 * `fs` is injected so the read stays on the fs-layer boundary (Phase 4+
 * rule: no new direct `fs.*` calls) and the reader is unit-testable
 * against an in-memory layer.
 */
export function readSidecar(
  fs: FileAccessLayer,
  claudeDir: string,
  pid: number,
): SidecarSnapshot | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const path = join(claudeDir, 'sessions', `${pid}.json`)

  let raw: string
  try {
    if (!fs.existsSync(path)) return null
    raw = fs.readFileSync(path)
  } catch {
    // Read failure (vanished between existsSync and read, permission,
    // I/O error). Fail-closed.
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const obj = parsed as Record<string, unknown>

  // sessionId is the only mandatory field — correlation matches the
  // materialised sessionId against it. Without it there is nothing to
  // correlate.
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) return null

  return {
    pid,
    sessionId: obj.sessionId,
    agent: typeof obj.agent === 'string' ? obj.agent : null,
    procStart: typeof obj.procStart === 'string' ? obj.procStart : null,
    startedAt: typeof obj.startedAt === 'number' ? obj.startedAt : null,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : null,
  }
}
