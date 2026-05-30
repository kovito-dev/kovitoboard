/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Upload-tracker helpers — defence-in-depth bookkeeping for the
 * cleanup-vs-upload interleave window.
 *
 * **Threat model (what this guards against):**
 *
 *   1. Cleanup heuristic evolution. The current sweep only reads
 *      `stat.mtimeMs`, and `/api/upload` today buffers the body
 *      with `express.raw()` then performs a single synchronous
 *      `fs.writeFileSync()` on the Node event loop — so the
 *      sweep cannot interleave with a half-written file under
 *      the v0.2.1 implementation. The tracker exists so that any
 *      future cleanup heuristic that reads more than mtime
 *      (size > 0 check, content sniff, partial-file detection,
 *      fd-based identity) starts from a baseline where in-flight
 *      basenames are already invisible to the sweep, instead of
 *      racing the moment the new heuristic ships.
 *
 *   2. Streaming uploads. If `/api/upload` ever switches from
 *      `express.raw()` to a streaming consumer (`fs.createWriteStream`
 *      or busboy-style chunk pipes), the synchronous-write
 *      guarantee disappears immediately. The tracker keeps the
 *      sweep blind to streaming candidates for free.
 *
 *   3. Multi-process workers. A future deployment that forks
 *      multiple Node workers against the same upload directory
 *      would need shared coordination; the in-process tracker is
 *      the local half of that contract (the cross-process half
 *      would replace this Set with a file-lock or external
 *      registry).
 *
 *   4. Clock skew / FS re-mount. The mtime comparison can also
 *      misfire on a re-mounted volume or after a sysclock jump
 *      that leaves a fresh upload's mtime older than the wall-
 *      clock cutoff. The in-flight skip keeps the sweep from
 *      acting on the (legitimate, in-progress) write under such
 *      perturbations.
 *
 * **What this does NOT claim to solve:**
 *
 *   * A swap or unlink of a freshly-written file between the
 *     handler returning and any downstream consumer reading
 *     it back. That is a separate threat handled by the
 *     scope-validator / artifact-path-validator pipeline.
 *
 * **Why a separate module.** Splitting the helper out of
 * `index.ts` lets the race scenario be exercised in unit tests
 * via an injected `FileAccessLayer` stub and `now` clock, without
 * standing up the HTTP server or sleeping for the production
 * 60-minute interval.
 *
 * See security-threat-model.md (compensatory review S9) for the
 * original threat shape this PR closes (the defence is now
 * surfaced as future-proofing rather than a directly-reachable
 * race under v0.2.1's synchronous-write handler).
 */
import { join } from 'path'
import type { FileAccessLayer } from './fs-layer'

/**
 * Basenames of uploads that are currently being written. The
 * upload handler adds an entry before invoking
 * `fs.writeFileSync` and removes it in a `finally` block so the
 * tracker stays consistent even when the write throws.
 *
 * Exported as a singleton so the upload handler and the periodic
 * sweep share one state. Tests reset it via `inFlightUploads.clear()`
 * to keep cases independent.
 */
export const inFlightUploads = new Set<string>()

export interface CleanupUploadsDeps {
  fs: FileAccessLayer
  uploadDir: string
  /** Time-to-live in milliseconds. Files older than this are deleted. */
  ttlMs: number
  /**
   * Wall-clock provider. Defaults to `Date.now`; tests inject a
   * deterministic clock so the TTL boundary is exercised without
   * sleeping.
   */
  now?: () => number
}

/**
 * Build a `cleanupUploads` function bound to the supplied
 * filesystem layer, upload directory, and TTL. Returning a
 * configured callable lets `index.ts` continue to drive the
 * periodic interval while keeping the body free of module-level
 * I/O side effects.
 *
 * The returned function is intentionally exception-safe: any
 * thrown error during the sweep (e.g. a concurrent `readdir`
 * race) is swallowed so an isolated failure does not poison the
 * periodic interval.
 */
export function createCleanupUploads({
  fs,
  uploadDir,
  ttlMs,
  now = Date.now,
}: CleanupUploadsDeps): () => void {
  return function cleanupUploads(): void {
    try {
      if (!fs.existsSync(uploadDir)) return
      const cutoff = now() - ttlMs
      for (const file of fs.readdirSync(uploadDir)) {
        if (inFlightUploads.has(file)) continue
        const filePath = join(uploadDir, file)
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath)
        }
      }
    } catch {
      /* Cleanup must never throw — see header comment. */
    }
  }
}
