/**
 * WebSocket イベント型定義（一元管理）
 *
 * 本ファイルは server / renderer の両方から参照されるため、Node.js / DOM
 * どちらの型にも依存しないこと。実装上の都合で type-only import 推奨。
 *
 * Phase 5 で追加。既存の broadcast 呼び出し（new_event / status_change 等）
 * との互換性を保ちつつ、trust-prompt-relay 関連のイベントを追加する。
 */

// =========================
// 汎用メタ
// =========================

/** プロンプトの種別（UI 表示分類用）。パターン定義ファイルの `kind` と同期する */
export type TrustPromptKind =
  | 'folder-trust'
  | 'write'
  | 'edit'
  | 'bash'
  | 'sandbox-network'
  | 'other'

/** UI に表示する選択肢 1 件 */
export interface TrustPromptChoice {
  /** 選択肢 ID（パターン定義と同期） */
  id: string
  /** UI 表示ラベル */
  label: string
  /**
   * tmux send-keys に渡すキー列。
   * - 末尾が `\n` で終わる場合、`\n` を `Enter` キーに変換して送信する
   * - 例: `"1\n"` → `tmux send-keys -- 1 Enter`
   * - 例: `"Enter"` → `tmux send-keys -- Enter`
   */
  keys: string
}

// =========================
// サーバー → クライアント
// =========================

/** パターンマッチが成功して trust prompt を検知した */
export interface TrustPromptDetectedPayload {
  /** サーバー側で一意に採番された prompt ID（応答時の照合に使用） */
  promptId: string
  /** 対象 tmux ウィンドウ名（= エージェント ID） */
  windowName: string
  /** プロンプト種別 */
  kind: TrustPromptKind
  /** マッチしたパターン定義の ID */
  patternId: string
  /** パターン定義の extract で抽出された付加情報（キーはパターン固有） */
  detail: Record<string, string | null>
  /** 縮退表示（選択肢数が通常と異なる等）を示す警告フラグ */
  degenerate: boolean
  /** UI に表示する選択肢 */
  choices: TrustPromptChoice[]
  /** tmux capture の末尾（30 行程度） */
  rawBuffer: string
}

/** パターン不一致だが状態ベース検知が入力待ちと判定した（未知プロンプト） */
export interface TrustPromptFallbackPayload {
  promptId: string
  windowName: string
  /** tmux capture の末尾（50 行程度） */
  rawBuffer: string
}

/** 応答送信が完了しプロンプトが消えたことを UI に通知する */
export interface TrustPromptResolvedPayload {
  promptId: string
  windowName: string
}

export type ServerToClientEvent =
  | { type: 'new_event'; payload: { sessionId: string; event: unknown } }
  | { type: 'status_change'; payload: { sessionId: string; status: string } }
  | { type: 'new_session'; payload: { summary: unknown } }
  | { type: 'process_end'; payload: { processId: string; status: string; exitCode: number } }
  | { type: 'trust_prompt_detected'; payload: TrustPromptDetectedPayload }
  | { type: 'trust_prompt_fallback'; payload: TrustPromptFallbackPayload }
  | { type: 'trust_prompt_resolved'; payload: TrustPromptResolvedPayload }

// =========================
// クライアント → サーバー
// =========================

export type TrustPromptResponseMode = 'choice' | 'raw-keys'

export interface TrustPromptRespondPayload {
  promptId: string
  windowName: string
  response:
    | { mode: 'choice'; choiceId: string }
    | { mode: 'raw-keys'; rawKeys: string }
}

export type ClientToServerEvent =
  | { type: 'trust_prompt_respond'; payload: TrustPromptRespondPayload }

// =========================
// イベント型ユーティリティ
// =========================

/** 特定の type を持つサーバーイベントだけを抽出するユーティリティ */
export type ServerEventOf<T extends ServerToClientEvent['type']> = Extract<
  ServerToClientEvent,
  { type: T }
>
