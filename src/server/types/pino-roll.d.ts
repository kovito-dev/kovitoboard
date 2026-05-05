/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Minimal ambient types for `pino-roll` (no official @types package
 * is published). Only the surface used by `src/server/logger.ts` is
 * typed; extend as needed.
 *
 * Reference: pino-roll v4 README.
 */
declare module 'pino-roll' {
  import type { Writable } from 'stream'

  interface PinoRollOptions {
    /** Base file path. pino-roll appends date / index per rotation. */
    file: string
    /** Rotation frequency. */
    frequency?: 'daily' | 'hourly' | number
    /** Max bytes per file before forced rotation. e.g. '500m'. */
    size?: string | number
    /** date-fns format for the rotated filename's date segment. */
    dateFormat?: string
    /** File extension applied after the rotation segment. */
    extension?: string
    /** Maintain a stable symlink to the current file. */
    symlink?: boolean
    /** Custom symlink filename. */
    symlinkPath?: string
    /**
     * Limit configuration. Either `count` (max number of files) or
     * `removeOtherLogFiles` (delete pre-existing logs at startup) or
     * both can be supplied.
     */
    limit?: {
      count?: number
      removeOtherLogFiles?: boolean
    }
  }

  /**
   * Returns a Promise resolving to a Writable suitable for use as a
   * pino destination stream.
   */
  export default function pinoRoll(opts: PinoRollOptions): Promise<Writable>
}
