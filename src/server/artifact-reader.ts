import { extname } from 'path'
import type { FileAccessLayer } from './fs-layer'

export interface ArtifactReadResult {
  content: string
  filePath: string
  language: string
  size: number
}

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.sh': 'bash',
  '.sql': 'sql',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.toml': 'toml',
  '.xml': 'xml',
  '.txt': 'text',
}

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export function readArtifact(fs: FileAccessLayer, filePath: string): ArtifactReadResult | null {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_FILE_SIZE) {
      return {
        content: `[ファイルサイズが大きすぎます: ${(stat.size / 1024).toFixed(0)}KB]`,
        filePath,
        language: 'text',
        size: stat.size,
      }
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const ext = extname(filePath).toLowerCase()
    const language = LANGUAGE_MAP[ext] || 'text'

    return { content, filePath, language, size: stat.size }
  } catch {
    return null
  }
}
