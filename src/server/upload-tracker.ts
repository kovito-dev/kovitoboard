/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Upload-tracker helpers — defend `cleanupUploads` against the race
 * where a concurrent upload is mid-write when the periodic sweep
 * runs.
 *
 * The TTL-based cleanup compares `stat.mtimeMs` against the
 * configured cutoff, so under normal conditions a freshly-written
 * file is far outside the deletion window. But the contract is
 * fragile: any future cleanup heuristic that reads more than mtime
 * (size > 0 check, content sniff, etc.) would suddenly start
 * racing against in-flight writes, and even today a system clock
 * jump or a re-mounted volume can produce an `mtimeMs` that is
 * older than wall-clock `now`. We therefore explicitly mark the
 * basename as in-flight for the duration of the write and skip
 * any in-flight basename from the sweep.
 *
 * The implementation is split off from `index.ts` so the race
 * scenario can be exercised in unit tests without standing up
 * the full HTTP server.
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
