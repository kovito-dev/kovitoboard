/**
 * ファイルパス検出・判定ユーティリティ
 * MessageBubble / MarkdownPreview で共通利用
 */

/** プレビュー可能なファイル拡張子 */
export const PREVIEWABLE_EXTENSIONS = [
  '.md', '.txt',
  '.ts', '.tsx', '.js', '.jsx',
  '.py', '.json', '.yaml', '.yml',
  '.html', '.css', '.sh', '.sql',
  '.go', '.rs', '.java', '.toml', '.xml',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
]

/**
 * テキスト内のファイルパスを検出する正規表現
 * パターン: 英数字/_/- で構成された path/to/file.ext 形式
 */
export const FILE_PATH_REGEX = /(?:^|(?<=[\s`'"(（]))([a-zA-Z0-9_.~/-]+\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)(?=[\s`'"）),:;。、]|$)/g

/** ファイルがプレビュー可能な拡張子かを判定 */
export function hasPreviewableExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return PREVIEWABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
