/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Filesystem capability probe (spec `cwd-allowlist.md` v1.0 §7.6).
 *
 * `probeWorkRoot()` writes a short-lived sentinel file inside the
 * supplied root, immediately re-stats it through a case-variant of the
 * same name, and reports whether the filesystem treats the two as the
 * same entry. The result drives the per-root case-sensitivity rule
 * used by `validateCwd()` to compare cwd inputs against the allow-list.
 *
 * Design points:
 *   - Caller-side I/O only. Spec §7.6 forbids `validateCwd()` from
 *     performing probes itself (pure-function constraint, §6.3 SSOT).
 *     The three legitimate callers are: `POST /api/work-roots`
 *     handler, KB bootstrap, and the per-request precheck.
 *   - Fail-closed. If anything in the write/stat/delete cycle throws,
 *     the probe returns `null` so the caller surfaces `probe_failed`
 *     (HIGH 2 in CodeX Attempt 1 — fail-open would let
 *     case-insensitive FS quietly conflate `/Proj` and `/proj`).
 *   - Best-effort cleanup. The sentinel is removed in a `finally`
 *     branch; a leaked probe file under .kovitoboard control surface
 *     is harmless but we still try to clean it up so a future probe
 *     does not collide.
 */

import { randomBytes } from 'crypto'
import { join } from 'path'
import type { FileAccessLayer } from './fs-layer'
import type { WorkRootMetadata } from '../shared/setting-types'

/**
 * Probe the case-sensitivity of `rootPath`'s filesystem.
 *
 * Returns `WorkRootMetadata` on success or `null` when the probe
 * could not complete (write denied / IO error / cleanup failure on
 * the sentinel itself — see fail-closed contract above).
 */
export function probeWorkRoot(
  rootPath: string,
  fs: FileAccessLayer,
): WorkRootMetadata | null {
  // 8 hex chars from /dev/urandom keeps probes from colliding when
  // multiple roots are probed in parallel (rare, but onboarding +
  // POST /api/work-roots can race during the wizard's last second).
  const suffix = randomBytes(4).toString('hex')
  const lowerName = `.kovitoboard-fs-probe-${suffix}`
  const upperName = `.KOVITOBOARD-FS-PROBE-${suffix}`
  const lowerPath = join(rootPath, lowerName)
  const upperPath = join(rootPath, upperName)

  let createdLower = false
  try {
    fs.writeFileSync(lowerPath, '')
    createdLower = true
    const caseInsensitive = fs.existsSync(upperPath)
    return {
      caseSensitive: !caseInsensitive,
      probedAt: new Date().toISOString(),
    }
  } catch {
    return null
  } finally {
    if (createdLower) {
      try {
        fs.unlinkSync(lowerPath)
      } catch {
        // best-effort cleanup; a leaked sentinel is non-fatal.
      }
    }
  }
}
