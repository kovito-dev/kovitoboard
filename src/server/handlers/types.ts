/**
 * Recipe handler system — core type definitions.
 *
 * Category A handler 9 個の入出力スキーマ、共通レスポンス型、
 * scope 7 種、handler 定義インターフェースを一元管理する。
 *
 * @see recipe-system.md §12-2 (Category A handler set)
 * @see recipe-system.md §12-2-1 (input/output schemas)
 * @see recipe-system.md §12-3 (scope definitions)
 * @stable v0.1.0
 */

// =========================================
// Error codes
// =========================================

/**
 * Handler error codes (全 handler 共通).
 * @see recipe-system.md §12-2-1
 */
export type HandlerErrorCode =
  | 'ScopeViolation'    // 宣言していない scope が必要な操作
  | 'PathOutOfScope'    // scope の対象領域外のパス
  | 'PathForbidden'     // ハードコード除外リスト（§12-3-1）に該当
  | 'NotFound'          // 対象が存在しない
  | 'SizeExceeded'      // サイズ上限超過
  | 'RateLimited'       // レート制限に抵触
  | 'InvalidArgs'       // 引数バリデーションエラー
  | 'HandlerNotDeclared' // api.calls[].id で未宣言の呼び出し
  | 'Internal'          // サーバー内部エラー

// =========================================
// Response type
// =========================================

/**
 * 共通 handler レスポンス型（ok/error discriminated union）.
 * @see recipe-system.md §12-2-1
 */
export type HandlerResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: HandlerErrorCode; message: string } }

// =========================================
// Response factory helpers
// =========================================

/** 成功レスポンスを生成する */
export function handlerOk<T>(data: T): HandlerResponse<T> {
  return { ok: true, data }
}

/** エラーレスポンスを生成する */
export function handlerError<T = never>(
  code: HandlerErrorCode,
  message: string,
): HandlerResponse<T> {
  return { ok: false, error: { code, message } }
}

// =========================================
// Scope
// =========================================

/**
 * scope 7 種の定義.
 * handler の実行に必要な権限を表す。インストール時にユーザーが承認する。
 * @see recipe-system.md §12-3
 */
export type Scope =
  | 'project-read'    // プロジェクトルート配下（除外リストを除く）の読み取り
  | 'project-write'   // 同上の書き込み
  | 'agents-read'     // .claude/agents/ 配下の読み取り
  | 'skills-read'     // .claude/skills/ 配下の読み取り
  | 'claude-md-read'  // 各種 CLAUDE.md ファイルの読み取り
  | 'kb-data-read'    // kovitoboard/data/ 配下の読み取り
  | 'own-data'        // app/data/{recipe-id}/ 配下の読み書き

// =========================================
// Handler names
// =========================================

/**
 * Category A handler 名（v0.1.0 で提供する 9 個）.
 * @see recipe-system.md §12-2
 */
export type CategoryAHandlerName =
  | 'list-files'
  | 'read-file'
  | 'write-file'
  | 'kv-get'
  | 'kv-set'
  | 'kv-list'
  | 'kv-delete'
  | 'notify'
  | 'export-file'

/**
 * handler 名ごとの必要 scope マッピング.
 * 各 handler は指定された scope のいずれか 1 つ以上が承認されていれば実行可能。
 * @see recipe-system.md §12-2 handler 一覧表
 */
export const HANDLER_REQUIRED_SCOPES: Record<CategoryAHandlerName, Scope[]> = {
  'list-files': ['project-read', 'project-write', 'agents-read', 'skills-read', 'claude-md-read', 'kb-data-read', 'own-data'],
  'read-file': ['project-read', 'project-write', 'agents-read', 'skills-read', 'claude-md-read', 'kb-data-read', 'own-data'],
  'write-file': ['project-write', 'own-data'],
  'kv-get': ['own-data'],
  'kv-set': ['own-data'],
  'kv-list': ['own-data'],
  'kv-delete': ['own-data'],
  'notify': [],    // scope 不要（ユーザー可視）
  'export-file': [], // scope 不要（ユーザー明示操作が介在）
}

// =========================================
// Handler definition interface
// =========================================

/**
 * handler 実行時のコンテキスト.
 * dispatcher から handler.execute() に渡される。
 */
export interface HandlerContext {
  /** ターゲットプロジェクトのルートパス */
  projectRoot: string
  /** レシピ ID（own-data パス解決に使用） */
  recipeId: string
  /** このレシピに対して承認済みの scope 一覧 */
  approvedScopes: readonly Scope[]
}

/**
 * handler 実装のインターフェース.
 * 各 Category A handler はこのインターフェースに準拠するオブジェクトを export する。
 */
export interface HandlerDef<TInput = unknown, TOutput = unknown> {
  /** handler 名（CategoryAHandlerName と一致） */
  name: CategoryAHandlerName
  /** この handler の実行に必要な scope（いずれか 1 つが承認されていれば可） */
  requiredScopes: readonly Scope[]
  /** 入力引数をバリデーションする。有効なら null、無効ならエラーメッセージを返す */
  validate: (input: unknown) => string | null
  /** handler を実行する */
  execute: (
    input: TInput,
    context: HandlerContext,
  ) => Promise<HandlerResponse<TOutput>>
}

// =========================================
// Handler input/output types
// =========================================

// --- list-files ---
// @see recipe-system.md §12-2-1 list-files

export interface ListFilesInput {
  /** 対象ディレクトリパス（scope に応じた相対パス） */
  path: string
  /** 再帰探索。デフォルト false */
  recursive?: boolean
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  /** ISO 8601 */
  modifiedAt: string
}

export interface ListFilesOutput {
  entries: FileEntry[]
}

// --- read-file ---
// @see recipe-system.md §12-2-1 read-file

export interface ReadFileInput {
  /** 対象ファイルパス */
  path: string
  /** エンコーディング。デフォルト "utf-8" */
  encoding?: 'utf-8' | 'base64'
}

export interface ReadFileOutput {
  content: string
  size: number
  encoding: 'utf-8' | 'base64'
}

// --- write-file ---
// @see recipe-system.md §12-2-1 write-file

export interface WriteFileInput {
  /** 書き込み先パス */
  path: string
  /** 書き込む内容 */
  content: string
  /** エンコーディング。デフォルト "utf-8" */
  encoding?: 'utf-8' | 'base64'
  /** 途中ディレクトリの作成を許可。デフォルト false */
  createDirs?: boolean
}

export interface WriteFileOutput {
  /** 書き込んだバイト数 */
  written: number
}

// --- kv-get ---
// @see recipe-system.md §12-2-1 kv-get

export interface KvGetInput {
  key: string
}

export interface KvGetOutput {
  value: string | null
  existsAt?: string
}

// --- kv-set ---
// @see recipe-system.md §12-2-1 kv-set

export interface KvSetInput {
  key: string
  value: string
  /** TTL（秒）。省略時は無期限 */
  ttlSeconds?: number
}

// kv-set は { ok: true } のみ返す — 型は不要（HandlerResponse<KvSetOk> で使用）
export interface KvSetOk {
  ok: true
}

// --- kv-list ---
// @see recipe-system.md §12-2-1 kv-list

export interface KvListInput {
  /** キー prefix フィルタ */
  prefix?: string
  /** 返却上限。デフォルト 100、最大 1000 */
  limit?: number
}

export interface KvListOutput {
  keys: string[]
  hasMore: boolean
}

// --- kv-delete ---
// @see recipe-system.md §12-2-1 kv-delete

export interface KvDeleteInput {
  key: string
}

export interface KvDeleteOutput {
  /** 削除された（存在した）か */
  deleted: boolean
}

// --- notify ---
// @see recipe-system.md §12-2-1 notify

export interface NotifyInput {
  title: string
  body: string
  level?: 'info' | 'warning'
}

export interface NotifyOk {
  ok: true
}

// --- export-file ---
// @see recipe-system.md §12-2-1 export-file

export interface ExportFileInput {
  /** 保存ダイアログに提案するファイル名 */
  suggestedName: string
  /** ファイル内容 */
  content: string
  /** MIME タイプ（省略時はブラウザ推定） */
  mimeType?: string
  /** エンコーディング。デフォルト "utf-8" */
  encoding?: 'utf-8' | 'base64'
}

export interface ExportFileOutput {
  /** ユーザーが保存を承認したか */
  saved: boolean
  /** 保存先パス（キャンセル時は undefined） */
  savedPath?: string
}

// =========================================
// Limits / constants
// =========================================

/**
 * handler 制限値（recipe-system.md §12-2-1 の各制限に対応）.
 */
export const HANDLER_LIMITS = {
  /** list-files: 1 回のレスポンスで最大エントリ数 */
  LIST_FILES_MAX_ENTRIES: 1_000,
  /** list-files: own-data 時の最大再帰深度 */
  LIST_FILES_MAX_DEPTH_OWN: 5,
  /** list-files: own-data 以外の最大再帰深度 */
  LIST_FILES_MAX_DEPTH_OTHER: 2,

  /** read-file: 最大ファイルサイズ (10MB) */
  READ_FILE_MAX_SIZE: 10 * 1024 * 1024,
  /** write-file: 最大書き込みサイズ (10MB) */
  WRITE_FILE_MAX_SIZE: 10 * 1024 * 1024,

  /** KV: キー長最大 (256 文字) */
  KV_KEY_MAX_LENGTH: 256,
  /** KV: 値の最大サイズ (1MB) */
  KV_VALUE_MAX_SIZE: 1 * 1024 * 1024,
  /** KV: ストア合計最大サイズ (100MB) */
  KV_STORE_MAX_SIZE: 100 * 1024 * 1024,
  /** kv-list: デフォルト limit */
  KV_LIST_DEFAULT_LIMIT: 100,
  /** kv-list: 最大 limit */
  KV_LIST_MAX_LIMIT: 1_000,

  /** notify: title 最大長 (100 文字) */
  NOTIFY_TITLE_MAX_LENGTH: 100,
  /** notify: body 最大長 (500 文字) */
  NOTIFY_BODY_MAX_LENGTH: 500,
  /** notify: レート制限 (レシピ単位、/min) */
  NOTIFY_RATE_LIMIT_PER_MIN: 10,

  /** export-file: content 最大サイズ (50MB) */
  EXPORT_FILE_MAX_SIZE: 50 * 1024 * 1024,

  /** FE 側タイムアウト (30 秒) */
  HANDLER_TIMEOUT_MS: 30_000,
} as const

// =========================================
// Hardcoded exclusion patterns
// =========================================

/**
 * ハードコード除外パターン — scope に関わらず常にアクセス拒否.
 * scopeValidator.ts の 1 箇所のみで管理し、各 handler で個別判定しない。
 * @see recipe-system.md §12-3-1
 */
export const HARDCODED_EXCLUSIONS = [
  '.env',               // .env 完全一致
  '.env.*',             // .env.production, .env.local 等
  '.git/**',            // .git/ 配下全て
  'node_modules/**',    // node_modules/ 配下全て
  '.claude/credentials*', // .claude/credentials, .claude/credentials.json 等
] as const

// =========================================
// Audit log types
// =========================================

/**
 * 監査ログ 1 行のスキーマ.
 * app/data/{recipe-id}/_audit.log に JSONL 形式で書き出す。
 * @see recipe-system.md §12-6（将来）
 */
export interface AuditLogEntry {
  /** ISO 8601 タイムスタンプ */
  timestamp: string
  /** レシピ ID */
  recipeId: string
  /** 呼び出し ID（api.calls[].id） */
  callId: string
  /** handler 名 */
  handler: CategoryAHandlerName
  /** 引数の SHA-256 ハッシュ（生の引数はログしない） */
  argsHash: string
  /** レスポンスの ok/error */
  result: 'ok' | 'error'
  /** エラーコード（result === 'error' の場合のみ） */
  errorCode?: HandlerErrorCode
  /** 処理時間 (ms) */
  durationMs: number
}

/**
 * 監査ログのローテーション設定.
 */
export const AUDIT_LOG_LIMITS = {
  /** 最大ファイルサイズ (10MB) */
  MAX_SIZE: 10 * 1024 * 1024,
  /** ローテーション世代数 */
  MAX_GENERATIONS: 3,
} as const
