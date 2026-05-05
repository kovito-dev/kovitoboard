/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { wrapWithSentinel } from './kb-authored-sentinel'

/**
 * app-creation-prompt — build the initial message that the
 * "Create new app" modal sends to the chosen agent.
 *
 * Spec: docs/specs/v0.1.0-app-creation-flow.md §5.
 *
 * Sanitization policy (spec §5.3): user-typed text is NOT scrubbed
 * the way recipe instructions are (`recipe-inspector.sanitizeInstruction`),
 * because the trust boundary is different — the user authored the
 * input themselves. We do, however, fence each free-form field so an
 * accidental triple-backtick (or `${...}`, etc.) cannot break the
 * surrounding Markdown structure of the prompt. The fence width
 * adapts to the longest run of backticks already in the input
 * (CommonMark §4.5 — fenced code blocks).
 */
export interface AppCreationRequest {
  /** Required. What the app is for (free-form text). */
  purpose: string
  /** Optional. Where the app's input comes from. */
  input?: string
  /** Optional. What the app produces. */
  output?: string
  /** Optional. How often / when the user expects to use it. */
  frequency?: string
}

const UNFILLED_WITH_GUIDANCE =
  '（未記入。あなたの判断で適切な提案をしてください）'
const UNFILLED_PLAIN = '（未記入）'

/**
 * Wrap free-form user text in a fenced code block whose fence is
 * guaranteed to be longer than any backtick run inside the text.
 * Falls back to the standard 3-backtick fence when the text contains
 * no backticks. The leading and trailing newlines are part of the
 * CommonMark fence contract.
 */
function fenceUserText(text: string): string {
  const runs = text.match(/`+/g) ?? []
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fenceLen = Math.max(3, longestRun + 1)
  const fence = '`'.repeat(fenceLen)
  return `${fence}\n${text}\n${fence}`
}

/**
 * Treat empty strings, `undefined`, and whitespace-only strings as
 * "not filled in". Anything else is rendered fenced.
 */
function renderOptional(text: string | undefined, fallback: string): string {
  if (text === undefined) return fallback
  if (text.trim().length === 0) return fallback
  return fenceUserText(text)
}

/**
 * Build the prompt text that gets sent to the agent as the first
 * message in the new session. The structure intentionally mirrors
 * spec §5.2 so the agent can rely on the section headings.
 */
export function buildAppCreationPrompt(request: AppCreationRequest): string {
  const { purpose, input, output, frequency } = request

  const purposeBlock = fenceUserText(purpose)
  const inputBlock = renderOptional(input, UNFILLED_WITH_GUIDANCE)
  const outputBlock = renderOptional(output, UNFILLED_WITH_GUIDANCE)
  const frequencyBlock = renderOptional(frequency, UNFILLED_PLAIN)

  // SS-3 / Q4 dual-write: keep the legacy `KovitoBoard App Creation
  // Request` first-line anchor so older renderers chip-collapse the
  // message, while wrapping the whole body in the v1.0 sentinel for
  // sentinel-aware ones.
  const body = [
    'KovitoBoard App Creation Request',
    '',
    '## ユーザーの要件',
    '',
    '### 目的と概要',
    '',
    purposeBlock,
    '',
    '### インプット（何を渡す / 何を起点に動くか）',
    '',
    inputBlock,
    '',
    '### アウトプット（何が得られるか）',
    '',
    outputBlock,
    '',
    '### 使う頻度・タイミング',
    '',
    frequencyBlock,
    '',
    '---',
    '',
    '## あなた（エージェント）への依頼',
    '',
    '以下の 4 ステップで進めてください。',
    '',
    '### Step 1: 要件確認',
    '',
    'ユーザーの要件を読み、不明点があれば質問してください（複数質問可）。',
    '特に以下が曖昧な場合は質問が必要です:',
    '- 入力データの形式（テキスト / ファイル / URL / 定期実行 など）',
    '- 出力の保存先（画面表示のみ / ファイル生成 / 履歴蓄積 など）',
    '- 既存データソースとの連携（プロジェクト内のファイル / 外部 API など）',
    '',
    '### Step 2: 設計提案',
    '',
    '要件が確認できたら、以下を提案してください:',
    '- アプリ ID（小文字英数+ハイフン、`/^[a-z][a-z0-9-]{0,63}$/`、ディレクトリ名兼用）',
    '- アイコン（`sessions / folder / settings / agents / dashboard / seeds / content / git / slides / brands / devroom` から選択）',
    '- BE 要否（API ハンドラが必要か。`docs/agent-ref/05-apps.md` §4 / §8 を参考に判断）',
    '- 概要設計（ファイル構成 + 機能フロー + データの置き場所）',
    '',
    '### Step 3: ユーザー確認 → 実装',
    '',
    'ユーザーが Step 2 の提案を確認・修正したら、`app/{app-id}/` 配下に実装してください。',
    '実装時は以下の制約を守ってください:',
    '',
    '- `app/` 配下のみで作業すること（`src/`、`.claude/`、`config/` 等は触らない）',
    '- `npm install` / `yarn add` / `pnpm add` / `npx` 等のパッケージ追加コマンドを実行しない',
    '- ネットワークコマンド（curl / wget / ssh / scp）を実行しない',
    '- `app/menu.ts` への登録を忘れずに行う（存在しない場合は新規作成）',
    '- 既存の `app.example/` の実装パターン（特に `app.example/research-reports/`）を参考にする',
    '- BE が必要な場合、ネスト配置（`app/{app-id}/api/*.ts`）を採用する（DEC-008）',
    '',
    '### Step 4: 動作確認の案内',
    '',
    '実装完了後、ユーザーに以下を案内してください:',
    '',
    '- 作成したファイル一覧',
    '- アプリへのアクセス方法（サイドバーの新メニューをクリック）',
    '- 動作確認の手順',
    '- 想定通り動かない場合のデバッグ方法（`.kovitoboard/logs/server.log` の参照等）',
    '',
    '---',
    '',
    '## 参考ドキュメント',
    '',
    '- `docs/agent-ref/05-apps.md`: 独自アプリ開発（`app/` ディレクトリ）の解説',
    '- `app.example/research-reports/`: 長時間処理を伴う BE 付きアプリの参考実装',
    '- `docs/agent-ref/08-logging.md`: ロギング規約',
  ].join('\n')

  return wrapWithSentinel('app-create', body)
}
