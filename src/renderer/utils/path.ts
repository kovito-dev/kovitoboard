/**
 * File path detection and validation utilities.
 * Shared by MessageBubble and MarkdownPreview.
 */

/** File extensions that can be previewed */
export const PREVIEWABLE_EXTENSIONS = [
  '.md', '.txt',
  '.ts', '.tsx', '.js', '.jsx',
  '.py', '.json', '.yaml', '.yml',
  '.html', '.css', '.sh', '.sql',
  '.go', '.rs', '.java', '.toml', '.xml',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
]

/**
 * Regular expression to detect file paths in text.
 * Pattern: path/to/file.ext composed of alphanumeric characters, _, -, /, and .
 */
export const FILE_PATH_REGEX = /(?:^|(?<=[\s`'"(（]))([a-zA-Z0-9_.~/-]+\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)(?=[\s`'"）),:;。、]|$)/g

/** Check whether a file has a previewable extension */
export function hasPreviewableExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return PREVIEWABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
