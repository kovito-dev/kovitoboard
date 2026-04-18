import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from './fs-layer'
import type { ViewerConfig } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_CONFIG: ViewerConfig = {
  claudeDir: join(process.env.HOME || '', '.claude'),
  watcher: {
    usePolling: true,
    pollInterval: 1500
  },
  agents: {
    default: { name: 'デフォルト', color: '#A67B5B' }
  },
  user: { name: 'ユーザー', color: '#7C3AED' },
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
 * Module-level cache for the resolved project root.
 * Set on first call to resolveProjectRoot() and reused thereafter,
 * eliminating repeated fs access from paths.ts / setting-manager.ts etc.
 */
let cachedProjectRoot: string | null = null

/**
 * プロジェクトルートを解決する（DEC-009）。
 *
 * 優先順位:
 *   ① --project-root CLI 引数
 *   ② KOVITOBOARD_PROJECT_ROOT 環境変数
 *   ③ .kovitoboard/setting.json の project.path
 *   ④ process.cwd() フォールバック
 *
 * 結果はモジュールレベルでキャッシュされるため、
 * 2 回目以降の呼び出しは fs アクセスなしで即座に返る。
 */
export function resolveProjectRoot(fs: FileAccessLayer): string {
  if (cachedProjectRoot) return cachedProjectRoot

  // 1. CLI 引数
  const argRoot = parseProjectRootArg(process.argv)
  if (argRoot) {
    cachedProjectRoot = resolve(argRoot)
    return cachedProjectRoot
  }

  // 2. 環境変数
  const envRoot = process.env.KOVITOBOARD_PROJECT_ROOT
  if (envRoot && envRoot.trim().length > 0) {
    cachedProjectRoot = resolve(envRoot)
    return cachedProjectRoot
  }

  // 3. .kovitoboard/setting.json の project.path
  const persisted = readPersistedProjectRoot(fs, process.cwd())
  if (persisted) {
    cachedProjectRoot = persisted
    return cachedProjectRoot
  }

  // 4. process.cwd() フォールバック
  cachedProjectRoot = process.cwd()
  return cachedProjectRoot
}

/**
 * テスト用: キャッシュをリセットする。
 * プロダクションコードでは呼ばないこと。
 */
export function _resetProjectRootCache(): void {
  cachedProjectRoot = null
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
    if (typeof path === 'string' && path.length > 0) return resolve(path)
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
