/**
 * Scope Validator — scope ↔ パスのマッピング、除外リストの強制.
 *
 * handler dispatcher から呼ばれ、handler 実行前にパスが
 * 承認済み scope の領域内かつ除外リスト非該当であることを保証する。
 *
 * 除外リストは **ここの 1 箇所のみ** で管理する。
 * 各 handler で個別に除外判定しない。
 *
 * @see recipe-system.md §12-3 (scope definitions)
 * @see recipe-system.md §12-3-1 (hardcoded exclusion list)
 * @see recipe-backend-implementation-plan.md §8-2 原則 3
 * @stable v0.1.0
 */

import * as path from 'path'
import type { Scope, HandlerErrorCode } from './handlers/types.js'
import {
  normalizePath,
  resolveScopeRoot,
  isWithin,
  isClaudeMdPath,
  PathResolutionError,
} from './pathResolver.js'

// =========================================
// Exclusion patterns
// =========================================

/**
 * ハードコード除外パターン（全 scope 共通）.
 *
 * パスの相対部分（プロジェクトルートからの相対）に対してマッチングする。
 * @see recipe-system.md §12-3-1
 */
const EXCLUSION_MATCHERS: Array<(relativePath: string) => boolean> = [
  // .env（完全一致）
  (rel) => rel === '.env',
  // .env.*（.env.production, .env.local 等）
  (rel) => rel.startsWith('.env.'),
  // .env* がネストしている場合（例: subdir/.env）
  (rel) => {
    const basename = path.basename(rel)
    return basename === '.env' || basename.startsWith('.env.')
  },
  // .git/ 配下全て
  (rel) => rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\'),
  // node_modules/ 配下全て
  (rel) => rel === 'node_modules' || rel.startsWith('node_modules/') || rel.startsWith('node_modules\\'),
  // .claude/credentials*
  (rel) => {
    const normalized = rel.replace(/\\/g, '/')
    return normalized === '.claude/credentials' || normalized.startsWith('.claude/credentials')
  },
]

/**
 * 絶対パスが除外リストに該当するかを判定する.
 *
 * @param absPath - 正規化済みの絶対パス
 * @param projectRoot - プロジェクトルートパス
 * @returns true if the path is forbidden
 */
export function isForbidden(absPath: string, projectRoot: string): boolean {
  // プロジェクトルートからの相対パスを算出
  const rel = path.relative(projectRoot, absPath)

  // プロジェクト外（../ で始まる）のパスは除外リストのチェック不要
  // （scope 領域判定で弾かれるため）
  if (rel.startsWith('..')) return false

  return EXCLUSION_MATCHERS.some((matcher) => matcher(rel))
}

/**
 * list-files の結果エントリから除外パスを除去する.
 *
 * 除外パスに該当するエントリはエラーではなく「そもそも存在しない」として
 * 結果から除外する（メタデータ漏洩のサイドチャネル遮断）。
 *
 * @see recipe-system.md §12-3-1 list-files の除外挙動
 * @see recipe-system.md §12-2-1 list-files の除外リストの扱い
 */
export function filterExcludedEntries<T extends { path: string }>(
  entries: T[],
  projectRoot: string,
): T[] {
  return entries.filter((entry) => {
    const absPath = path.isAbsolute(entry.path)
      ? entry.path
      : path.join(projectRoot, entry.path)
    return !isForbidden(absPath, projectRoot)
  })
}

// =========================================
// Scope validation
// =========================================

export interface ScopeValidationResult {
  ok: boolean
  failedCode?: HandlerErrorCode
}

/**
 * パス引数が承認済み scope の領域内かつ除外リスト非該当であることを検証する.
 *
 * @param rawPath - handler が受け取ったパス引数（相対パス or 絶対パス）
 * @param approvedScopes - インストール時にユーザーが承認した scope
 * @param requiredScopes - この handler が必要とする scope（いずれか 1 つが承認済みなら OK）
 * @param recipeId - レシピ ID
 * @param projectRoot - ターゲットプロジェクトのルートパス
 * @param kovitoboardRoot - KovitoBoard インストールパス（kb-data-read で使用、省略可）
 *
 * @see recipe-backend-critical-reviews.md §2-3
 */
export function validatePathForScope(
  rawPath: string,
  approvedScopes: readonly Scope[],
  requiredScopes: readonly Scope[],
  recipeId: string,
  projectRoot: string,
  kovitoboardRoot?: string,
): ScopeValidationResult {
  // 承認済み scope と必要 scope の交差を求める
  const matchingScopes = requiredScopes.filter((s) =>
    approvedScopes.includes(s),
  )

  if (matchingScopes.length === 0) {
    return { ok: false, failedCode: 'ScopeViolation' }
  }

  // 各マッチング scope に対してパス検証を試みる
  // いずれか 1 つでも通れば OK
  for (const scope of matchingScopes) {
    const scopeRoot = resolveScopeRoot(scope, projectRoot, recipeId, kovitoboardRoot)
    let physical: string

    try {
      physical = normalizePath(rawPath, scopeRoot)
    } catch (err) {
      if (err instanceof PathResolutionError) {
        return { ok: false, failedCode: 'Internal' }
      }
      throw err
    }

    // claude-md-read は特殊判定（CLAUDE.md のみ許可）
    if (scope === 'claude-md-read') {
      if (isClaudeMdPath(physical, projectRoot)) {
        // 除外リスト判定（CLAUDE.md は通常該当しないが安全策）
        if (isForbidden(physical, projectRoot)) {
          continue // 次の scope を試す
        }
        return { ok: true }
      }
      continue // CLAUDE.md でなければ次の scope を試す
    }

    // scope 領域内判定
    if (!isWithin(physical, scopeRoot)) {
      continue // 次の scope を試す
    }

    // 除外リスト判定（scope 宣言に関わらず常に効く）
    if (isForbidden(physical, projectRoot)) {
      return { ok: false, failedCode: 'PathForbidden' }
    }

    return { ok: true }
  }

  // どの scope でも領域内判定をパスしなかった
  return { ok: false, failedCode: 'PathOutOfScope' }
}

/**
 * scope のみの検証（パス引数なしの handler 用）.
 * kv-* など own-data 固定の handler で使用する。
 */
export function validateScopeOnly(
  approvedScopes: readonly Scope[],
  requiredScopes: readonly Scope[],
): ScopeValidationResult {
  const hasMatch = requiredScopes.length === 0 ||
    requiredScopes.some((s) => approvedScopes.includes(s))
  return hasMatch
    ? { ok: true }
    : { ok: false, failedCode: 'ScopeViolation' }
}
