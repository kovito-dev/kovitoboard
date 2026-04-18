/**
 * Path Resolver — scope ごとのベースパス解決とパス正規化.
 *
 * handler が受け取るパス引数を安全に正規化し、scope 領域内に
 * 収まっていることを保証する。Symlink 展開・パストラバーサル防止を含む。
 *
 * @see recipe-system.md §12-3 (scope definitions)
 * @see recipe-backend-critical-reviews.md §2 (Q-B1 確定方針)
 * @stable v0.1.0
 */

import * as path from 'path'
import * as fs from 'fs'
import type { Scope } from './handlers/types.js'

/**
 * scope ごとのベースパス（絶対パス）を返す.
 *
 * @param scope - 解決対象の scope
 * @param projectRoot - ターゲットプロジェクトのルートパス
 * @param recipeId - レシピ ID（own-data で使用）
 * @param kovitoboardRoot - KovitoBoard インストールパス（kb-data-read で使用）
 *
 * @see recipe-system.md §12-3
 */
export function resolveScopeRoot(
  scope: Scope,
  projectRoot: string,
  recipeId: string,
  kovitoboardRoot?: string,
): string {
  switch (scope) {
    case 'project-read':
    case 'project-write':
      return projectRoot
    case 'agents-read':
      return path.join(projectRoot, '.claude', 'agents')
    case 'skills-read':
      return path.join(projectRoot, '.claude', 'skills')
    case 'claude-md-read':
      return projectRoot // CLAUDE.md はプロジェクトルート直下
    case 'kb-data-read':
      return path.join(kovitoboardRoot || projectRoot, 'data')
    case 'own-data':
      return path.join(projectRoot, 'app', 'data', recipeId)
    default: {
      const _exhaustive: never = scope
      throw new Error(`Unknown scope: ${_exhaustive}`)
    }
  }
}

/**
 * パスを正規化する（3 段階の正規化フロー）.
 *
 * Step 1: 絶対パス化（scopeRoot と rawPath を結合）
 * Step 2: ../ 正規化（論理解決）
 * Step 3: fs.realpathSync で Symlink 展開（物理解決）
 *
 * @see recipe-backend-critical-reviews.md §2-2
 */
export function normalizePath(rawPath: string, scopeRoot: string): string {
  // Step 1: 絶対パス化
  const joined = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(scopeRoot, rawPath)

  // Step 2: ../. 正規化（論理解決）
  const normalized = path.normalize(joined)

  // Step 3: Symlink 展開（物理解決）
  const physical = realpathUpToExisting(normalized)

  return physical
}

/**
 * 存在するパスまで realpath で解決し、残りを論理結合する.
 *
 * 存在しないパスへの write-file では realpath が ENOENT を投げるため、
 * 最も近い既存親ディレクトリまで展開して残りのセグメントを結合する。
 *
 * @see recipe-backend-critical-reviews.md §2-2
 */
export function realpathUpToExisting(p: string): string {
  let current = p
  const segments: string[] = []

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break // ルート到達
    segments.unshift(path.basename(current))
    current = parent
  }

  try {
    const resolvedBase = fs.realpathSync(current)
    return segments.length > 0
      ? path.join(resolvedBase, ...segments)
      : resolvedBase
  } catch (err: unknown) {
    // ELOOP（Symlink ループ）等
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP') {
      throw new PathResolutionError('SYMLINK_LOOP', `Symlink loop detected: ${current}`)
    }
    throw new PathResolutionError('REALPATH_FAILED', `Failed to resolve path: ${current} (${code})`)
  }
}

/**
 * absPath が scopeRoot の配下にあるかを判定する.
 *
 * 両パスとも正規化済みであることを前提とする。
 */
export function isWithin(absPath: string, scopeRoot: string): boolean {
  // 末尾に区切り文字を追加して前方一致で判定
  // (scopeRoot="/foo/bar", absPath="/foo/barBaz" の誤判定を防ぐ)
  const root = scopeRoot.endsWith(path.sep) ? scopeRoot : scopeRoot + path.sep
  return absPath === scopeRoot || absPath.startsWith(root)
}

/**
 * claude-md-read scope の特殊判定.
 * CLAUDE.md ファイルのみアクセスを許可する。
 */
export function isClaudeMdPath(absPath: string, projectRoot: string): boolean {
  const basename = path.basename(absPath)
  if (basename !== 'CLAUDE.md') return false

  // プロジェクトルート直下、または .claude/ 配下の CLAUDE.md
  return isWithin(absPath, projectRoot)
}

// --- Error type ---

export class PathResolutionError extends Error {
  constructor(
    public readonly kind: 'SYMLINK_LOOP' | 'REALPATH_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'PathResolutionError'
  }
}
