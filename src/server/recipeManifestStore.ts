/**
 * Recipe Manifest Store — インストール済みレシピの manifest.json 管理.
 *
 * .kovitoboard/recipes-installed/{recipe-id}/manifest.json を読み書きし、
 * インメモリキャッシュとして保持する。
 *
 * - 起動時に全 manifest をスキャン・ロード
 * - 明示的な save/delete でキャッシュを更新
 * - ファイル監視はしない（v0.1.0 は起動時スキャン + 明示的更新のみ）
 *
 * @see recipe-system.md §12-5-1 (manifest.json)
 * @stable v0.1.0
 */

import { join } from 'path'
import type { FileAccessLayer } from './fs-layer.js'
import type { RecipeManifest } from './recipe/apiTypes.js'
import { isValidScope, isValidHandlerName } from './recipe/apiTypes.js'

// =========================================
// Store class
// =========================================

export class RecipeManifestStore {
  private cache = new Map<string, RecipeManifest>()
  private readonly baseDir: string

  /**
   * @param kovitoboardDir - .kovitoboard/ ディレクトリの絶対パス
   * @param fs - ファイルアクセスレイヤ
   */
  constructor(
    kovitoboardDir: string,
    private readonly fs: FileAccessLayer,
  ) {
    this.baseDir = join(kovitoboardDir, 'recipes-installed')
  }

  /**
   * 起動時に全 manifest をスキャンしてキャッシュにロードする.
   * 不正な manifest は警告ログ出力後スキップ。
   */
  loadAll(): void {
    this.cache.clear()

    if (!this.fs.existsSync(this.baseDir)) {
      return // ディレクトリ未作成 = インストール済みレシピなし
    }

    const entries = this.fs.readdirSync(this.baseDir)
    for (const entry of entries) {
      const manifestPath = join(this.baseDir, entry, 'manifest.json')
      if (!this.fs.existsSync(manifestPath)) {
        continue
      }

      try {
        const raw = this.fs.readFileSync(manifestPath, 'utf-8')
        const parsed = JSON.parse(raw) as unknown
        const validationError = validateManifest(parsed)
        if (validationError) {
          console.warn(`[manifest-store] Skipping invalid manifest: ${manifestPath} — ${validationError}`)
          continue
        }
        const manifest = parsed as RecipeManifest
        this.cache.set(manifest.recipeId, manifest)
      } catch (err) {
        console.warn(`[manifest-store] Failed to load manifest: ${manifestPath}`, err)
      }
    }

    console.log(`[manifest-store] Loaded ${this.cache.size} manifest(s)`)
  }

  /**
   * manifest を保存し、キャッシュを更新する.
   */
  save(manifest: RecipeManifest): void {
    const dir = join(this.baseDir, manifest.recipeId)
    if (!this.fs.existsSync(dir)) {
      this.fs.mkdirSync(dir, { recursive: true })
    }

    const manifestPath = join(dir, 'manifest.json')
    this.fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    this.cache.set(manifest.recipeId, manifest)
  }

  /**
   * 指定 recipeId の manifest を取得する.
   */
  get(recipeId: string): RecipeManifest | null {
    return this.cache.get(recipeId) ?? null
  }

  /**
   * 全 manifest を一覧で返す.
   */
  list(): RecipeManifest[] {
    return [...this.cache.values()]
  }

  /**
   * manifest を削除する（アンインストール用）.
   */
  delete(recipeId: string): void {
    const dir = join(this.baseDir, recipeId)
    const manifestPath = join(dir, 'manifest.json')
    if (this.fs.existsSync(manifestPath)) {
      this.fs.unlinkSync(manifestPath)
    }
    this.cache.delete(recipeId)
  }

  /**
   * 指定 recipeId がインストール済みかを返す.
   */
  has(recipeId: string): boolean {
    return this.cache.has(recipeId)
  }
}

// =========================================
// Validation
// =========================================

/**
 * manifest.json のバリデーション.
 * @returns null if valid, error message string if invalid
 */
function validateManifest(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'manifest must be an object'
  }

  const obj = raw as Record<string, unknown>

  // Required string fields
  for (const field of ['recipeId', 'version', 'hash', 'installedAt'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      return `"${field}" must be a non-empty string`
    }
  }

  // approvedScopes
  if (!Array.isArray(obj.approvedScopes)) {
    return '"approvedScopes" must be an array'
  }
  for (const scope of obj.approvedScopes) {
    if (!isValidScope(scope)) {
      return `approvedScopes contains invalid scope: "${String(scope)}"`
    }
  }

  // api
  if (typeof obj.api !== 'object' || obj.api === null || Array.isArray(obj.api)) {
    return '"api" must be an object'
  }
  const api = obj.api as Record<string, unknown>

  if (!Array.isArray(api.scopes)) {
    return '"api.scopes" must be an array'
  }
  for (const scope of api.scopes) {
    if (!isValidScope(scope)) {
      return `api.scopes contains invalid scope: "${String(scope)}"`
    }
  }

  if (!Array.isArray(api.calls)) {
    return '"api.calls" must be an array'
  }
  for (let i = 0; i < api.calls.length; i++) {
    const call = api.calls[i] as Record<string, unknown>
    if (typeof call !== 'object' || call === null) {
      return `api.calls[${i}] must be an object`
    }
    if (typeof call.id !== 'string' || call.id.length === 0) {
      return `api.calls[${i}].id must be a non-empty string`
    }
    if (!isValidHandlerName(call.handler)) {
      return `api.calls[${i}].handler "${String(call.handler)}" is not valid`
    }
  }

  return null
}
