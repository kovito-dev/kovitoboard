/**
 * Path constants for KovitoBoard data storage.
 *
 * KovitoBoard uses `.kovitoboard/` directly under the project root
 * as the storage location for runtime data.
 *
 * - `.kovitoboard/session-agents.jsonl`: Session-agent association records
 * - `/tmp/kovitoboard-uploads/`: Temporary upload file directory
 *
 * Constants are provided via lazy evaluation (functions).
 * `resolveProjectRoot()` uses a module-level cache (DEC-009),
 * so repeated calls do not incur fs access.
 */
import { join } from 'path'
import { tmpdir } from 'os'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'

/** The `.kovitoboard/` directory directly under the project root */
export function getKovitoboardDir(fs: FileAccessLayer): string {
  return join(resolveProjectRoot(fs), '.kovitoboard')
}

/** Session-agent association record file */
export function getSessionAgentsRecordPath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), 'session-agents.jsonl')
}

/**
 * Temporary upload file directory.
 * Placed under the system tmp directory (to avoid polluting the project).
 */
export function getUploadDir(): string {
  return join(tmpdir(), 'kovitoboard-uploads')
}

/**
 * Debug dump directory (trust-prompt detection).
 * Dump files are written when `KOVITOBOARD_DEBUG_TRUST=1` is enabled.
 */
export function getDebugTrustDir(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), 'debug', 'trust-prompt')
}

/**
 * Create the `.kovitoboard/` directory if it does not exist.
 * Should be called once at server startup.
 */
export function ensureKovitoboardDir(fs: FileAccessLayer): void {
  const dir = getKovitoboardDir(fs)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[paths] Created .kovitoboard/: ${dir}`)
  }
}
