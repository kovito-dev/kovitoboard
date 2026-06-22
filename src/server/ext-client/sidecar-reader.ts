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
/**
 * Size cap for a sidecar read. A real sidecar is a few hundred bytes; a
 * generous 64 KiB cap rejects a malformed / hostile oversized file
 * without blocking the event loop or allocating unbounded memory.
 */
const SIDECAR_MAX_BYTES = 64 * 1024

export function readSidecar(
  fs: FileAccessLayer,
  claudeDir: string,
  pid: number,
): SidecarSnapshot | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const path = join(claudeDir, 'sessions', `${pid}.json`)

  // Bounded, regular-file-gated read: rejects an oversized / non-regular
  // (FIFO / device / symlink-swapped) sidecar and closes the
  // exists→read TOCTOU window, all against a single fd. Fail-closed on
  // any of those, and on a genuine read error (absence / permission /
  // I/O), since this is a Claude Code internal path (§7.3.2.1 (S-1') (c)).
  let raw: string
  try {
    const r = fs.readFileBoundedSync(path, SIDECAR_MAX_BYTES)
    if (r.oversized || r.notRegular) return null
    raw = r.content
  } catch {
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

/** Upper bound on a `/proc/<pid>/stat` read. The file is tiny. */
const PROC_STAT_MAX_BYTES = 8 * 1024

/**
 * Read the OS-authoritative process birth identity + liveness for `pid`
 * from `/proc/<pid>/stat` field 22 (`starttime`, in clock ticks since
 * boot), for the launch-causality (S-6b) check (external-client-api.md
 * §7.3.2.1 (S-1') (b)).
 *
 * Why this is independent of the sidecar
 * --------------------------------------
 * The sidecar's own `procStart` is self-reported and can be STALE: if the
 * process exited and the PID was reused, a sidecar that has not been
 * rewritten still shows the old `procStart`, so matching the latched
 * birth-id against the sidecar's `procStart` is tautological for a stale
 * file. `/proc/<pid>/stat` is the live kernel source: its mere existence
 * proves the PID is alive, and `starttime` is stable for the life of that
 * exact process but differs after an exit→reuse. Latching `starttime` at
 * launch and re-reading it at correlate time therefore proves "the SAME
 * process is still alive" — liveness + birth identity in one read.
 *
 * Returns `null` (fail-closed) when the process is gone (ENOENT), the
 * file cannot be read, or field 22 is unparseable. `starttime` is parsed
 * after the LAST `')'` because field 2 (`comm`) is parenthesised and may
 * itself contain spaces / parentheses.
 *
 * `fs` is injected (Phase 4+ fs-layer boundary). `/proc/<pid>/stat`
 * reports as a regular file (size 0), so the bounded reader accepts it.
 */
export function readProcStarttime(fs: FileAccessLayer, pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  let raw: string
  try {
    const r = fs.readFileBoundedSync(`/proc/${pid}/stat`, PROC_STAT_MAX_BYTES)
    if (r.oversized || r.notRegular) return null
    raw = r.content
  } catch {
    // ENOENT (process exited) / read error → fail-closed (no liveness).
    return null
  }
  const lastParen = raw.lastIndexOf(')')
  if (lastParen < 0) return null
  // Fields after `comm`: state(3) ppid(4) ... starttime(22). After the
  // last ')', the remaining tokens start at field 3, so starttime is the
  // (22 - 3) = 19th 0-based index of the post-comm split.
  const after = raw.slice(lastParen + 1).trim().split(/\s+/)
  const starttime = after[19]
  if (typeof starttime !== 'string' || !/^\d+$/.test(starttime)) return null
  return starttime
}
