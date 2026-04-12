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

/** プロジェクトルート（CLAUDE.md が存在するディレクトリ）を動的に解決 */
export function resolveProjectRoot(fs: FileAccessLayer): string {
  // tsx 実行時: src/server/ → 3階層上がプロジェクトルート
  // ビルド後:  dist/        → 2階層上がプロジェクトルート
  const candidates = [
    resolve(__dirname, '..', '..', '..'),
    resolve(__dirname, '..', '..'),
  ]
  return candidates.find(p => fs.existsSync(join(p, 'CLAUDE.md'))) || candidates[0]
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
