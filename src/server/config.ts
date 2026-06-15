/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { join, resolve, dirname, isAbsolute } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from './fs-layer'
import type { ViewerConfig } from './types'
import { lazyChildLogger } from './logger'

const cfgLog = lazyChildLogger('config-resolver')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_CONFIG: ViewerConfig = {
  claudeDir: join(process.env.HOME || '', '.claude'),
  watcher: {
    usePolling: true,
    pollInterval: 1500
  },
  agents: {
    default: { name: 'Default', color: '#A67B5B' }
  },
  user: { name: 'User', color: '#7C3AED' },
  ui: {
    theme: 'dark',
    maxPreviewHeight: 300,
    autoScroll: true
  },
  window: {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600
  },
  project: undefined,
}

/**
 * Source of the resolved project root. Exposed in startup logs
 * (DEC-014) so operators can tell where the path came from.
 */
export type ProjectRootSource = 'cli-arg' | 'env' | 'setting-json' | 'cwd-fallback'

/**
 * Module-level cache for the resolved project root.
 * Set on first call and reused thereafter, eliminating repeated
 * fs access from paths.ts / setting-manager.ts etc.
 */
let cachedProjectRootResult: { path: string; source: ProjectRootSource } | null = null

/**
 * Resolve the project root and report which source was used (DEC-009 / DEC-014).
 *
 * Priority:
 *   1. --project-root CLI argument          → source: 'cli-arg'
 *   2. KOVITOBOARD_PROJECT_ROOT env var     → source: 'env'
 *   3. project.path from .kovitoboard/setting.json → source: 'setting-json'
 *   4. process.cwd() fallback               → source: 'cwd-fallback'
 *
 * The result is cached at the module level, so subsequent calls
 * return immediately without any fs access.
 */
export function resolveProjectRootWithSource(
  fs: FileAccessLayer
): { path: string; source: ProjectRootSource } {
  if (cachedProjectRootResult) return cachedProjectRootResult

  // 1. CLI argument
  const argRoot = parseProjectRootArg(process.argv)
  if (argRoot) {
    cachedProjectRootResult = { path: resolve(argRoot), source: 'cli-arg' }
    return cachedProjectRootResult
  }

  // 2. Environment variable
  const envRoot = process.env.KOVITOBOARD_PROJECT_ROOT
  if (envRoot && envRoot.trim().length > 0) {
    cachedProjectRootResult = { path: resolve(envRoot), source: 'env' }
    return cachedProjectRootResult
  }

  // 3. project.path from .kovitoboard/setting.json
  const persisted = readPersistedProjectRoot(fs, process.cwd())
  if (persisted) {
    cachedProjectRootResult = { path: persisted, source: 'setting-json' }
    return cachedProjectRootResult
  }

  // 4. process.cwd() fallback
  //
  // M-2 (`shared-installation-prevention-request.md` §M-2 + spec
  // `process-lifecycle.md` v1.2 §3.1): the cwd-fallback exists for
  // contributor / test ergonomics only — the embedded model
  // (kovitoboard-master-spec §2.2) requires --project-root or
  // KOVITOBOARD_PROJECT_ROOT in production. Emit a single WARN so
  // operators who land here by accident can spot the misconfiguration
  // in the startup log instead of after the UI presents the wrong
  // project. We do not refuse to start — that is M-1's responsibility
  // and is already enforced inside `tools/kb-start.mjs`.
  const cwd = process.cwd()
  cfgLog.warn(
    { resolved: cwd },
    '[config] WARN: project root resolved via cwd-fallback. ' +
      'Embedded mode expects an explicit --project-root or KOVITOBOARD_PROJECT_ROOT. ' +
      'See process-lifecycle.md §3 / agent-ref/11-lifecycle.md.',
  )
  cachedProjectRootResult = { path: cwd, source: 'cwd-fallback' }
  return cachedProjectRootResult
}

/**
 * Backward-compatible wrapper that returns only the path.
 * Existing callers (paths.ts, watcher.ts, etc.) do not need to change.
 */
export function resolveProjectRoot(fs: FileAccessLayer): string {
  return resolveProjectRootWithSource(fs).path
}

/**
 * Reset the cache. For testing only.
 * Do not call from production code.
 */
export function _resetProjectRootCache(): void {
  cachedProjectRootResult = null
}

function parseProjectRootArg(argv: string[]): string | null {
  const idx = argv.findIndex(a => a === '--project-root' || a.startsWith('--project-root='))
  if (idx === -1) return null
  const arg = argv[idx]
  if (arg.includes('=')) return arg.split('=', 2)[1] || null
  return argv[idx + 1] ?? null
}

function readPersistedProjectRoot(fs: FileAccessLayer, cwd: string): string | null {
  const settingPath = join(cwd, '.kovitoboard', 'setting.json')
  if (!fs.existsSync(settingPath)) return null
  try {
    const raw = fs.readFileSync(settingPath, 'utf-8')
    const data = JSON.parse(raw) as { project?: { path?: string } }
    const path = data.project?.path
    // `project.path` must be an absolute path. This minimal parser is the
    // setting-json stage of the project-root resolution chain and does NOT
    // go through `validateSetting()`, so the absolute-path invariant
    // (`data-persistence.md` §6.1.1) is enforced here, at the read site.
    // A relative value would be resolved by `resolve(path)` against the
    // launch cwd, retargeting the project root (and every derived side
    // effect: PID/log dirs, app symlink, tmux session) at the wrong
    // directory. Reject it fail-loud (return null → re-onboarding).
    if (typeof path === 'string' && path.length > 0 && isAbsolute(path)) {
      return resolve(path)
    }
    return null
  } catch {
    return null
  }
}

export function loadConfig(fs: FileAccessLayer): ViewerConfig {
  try {
    const projectRoot = resolveProjectRoot(fs)
    const candidates = [
      join(projectRoot, 'config/viewer.config.json'),
      join(__dirname, '../../config/viewer.config.json'),
      join(process.cwd(), 'config/viewer.config.json'),
    ]
    let raw: string | null = null
    for (const p of candidates) {
      try { raw = fs.readFileSync(p, 'utf-8'); break } catch { /* next */ }
    }
    if (!raw) throw new Error('config file not found')
    const fileConfig = JSON.parse(raw)

    if (fileConfig.claudeDir?.startsWith('~')) {
      fileConfig.claudeDir = fileConfig.claudeDir.replace('~', process.env.HOME || '')
    }

    return { ...DEFAULT_CONFIG, ...fileConfig }
  } catch {
    return DEFAULT_CONFIG
  }
}
