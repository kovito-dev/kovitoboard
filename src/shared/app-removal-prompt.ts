/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * app-removal-prompt — build the initial message that the
 * AppRemovalModal sends to the chosen agent. The prompt walks the
 * agent through the 5-step removal flow from
 * docs/agent-ref/05-apps.md §10.
 *
 * Spec: docs/specs/v0.1.0-app-removal-flow.md §5.
 *
 * Trust boundary: the inputs (`appId`, `displayName`, `manifest`)
 * come from the renderer's NavMenu state and the on-disk
 * `app/<appId>/manifest.json` — neither is user-typed free-form
 * content, so we do not run `sanitizeInstruction` here. We do,
 * however, validate the `appId` shape and fence the `displayName`
 * inside backticks so a stray `${...}` cannot break the surrounding
 * markdown (spec §5.3).
 */
import type { AppManifest } from './app-manifest-types'

export interface AppRemovalRequest {
  /** KB-local app identifier. Must match `/^[a-z][a-z0-9-]{0,63}$/`. */
  appId: string
  /** Display name shown in the menu (also rendered in the prompt). */
  displayName: string
  /**
   * The on-disk `app/<appId>/manifest.json`. `null` is a valid
   * input — pre-DEC-024 apps never wrote a manifest, and we want
   * removal to keep working for them.
   */
  manifest: AppManifest | null
}

/** Format constraint mirrors `app-id-collision.ts`. */
const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * Wrap free-form display text in a fenced code block whose fence is
 * guaranteed to be longer than any backtick run inside the text.
 * Mirrors the helper in `app-creation-prompt.ts`.
 */
function fenceUserText(text: string): string {
  const runs = text.match(/`+/g) ?? []
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fenceLen = Math.max(3, longestRun + 1)
  const fence = '`'.repeat(fenceLen)
  return `${fence}\n${text}\n${fence}`
}

/**
 * Build the prompt the agent receives as the first message of the
 * removal session. The structure follows spec §5.2 so the agent
 * can rely on the section headings.
 *
 * @throws Error when `appId` violates the slug pattern. The handler
 *   that builds the prompt server-side translates this into a 400.
 */
export function buildAppRemovalPrompt(request: AppRemovalRequest): string {
  const { appId, displayName, manifest } = request

  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error(`Invalid appId: ${JSON.stringify(appId)} (must match /^[a-z][a-z0-9-]{0,63}$/)`)
  }

  const sourceLine = (() => {
    if (!manifest) {
      return '- 由来: 不明（manifest 未配置 — 旧 KB から作成された可能性、または手動 install）'
    }
    if (manifest.source.type === 'recipe') {
      return `- 由来: レシピ「${manifest.source.recipeId}」（v${manifest.source.recipeVersion}、${manifest.source.recipeSource}）からインストール`
    }
    return `- 由来: 独自作成（${manifest.source.createdViaAgent} エージェントが作成）`
  })()

  const isRecipeSource = manifest?.source.type === 'recipe'

  return [
    'KovitoBoard App Removal Request',
    '',
    '## 削除対象',
    '',
    '### appId',
    '',
    appId,
    '',
    '### displayName',
    '',
    fenceUserText(displayName),
    '',
    '### source 情報（manifest 由来）',
    '',
    sourceLine,
    '',
    '---',
    '',
    '## あなた（エージェント）への依頼',
    '',
    `ユーザーがアプリ「${displayName}」（appId: ${appId}）の削除を依頼しました。`,
    '以下の手順で削除作業を進めてください。',
    '',
    '### Step 1: 状況確認',
    '',
    `1. \`app/${appId}/\` ディレクトリが存在するか確認（ls / Read で）`,
    `2. \`app/data/${appId}/\` ディレクトリが存在するか確認`,
    `3. \`app/menu.ts\` を Read して、\`menuEntries\` 配列内に \`id: '${appId}'\` のエントリがあることを確認`,
    `4. （manifest がある場合）\`app/${appId}/manifest.json\` を Read して source 情報を再確認`,
    '5. ユーザーが意図したアプリで間違いないか、対話で確認:',
    `   - 「アプリ『${displayName}』（appId: ${appId}）を削除します。よろしいですか？」`,
    '   - 念のため、アプリのファイル一覧を提示してユーザーに確認を求める',
    '',
    '### Step 2: 削除作業',
    '',
    'ユーザーが OK を出したら、以下を順に削除:',
    '',
    '#### 2.1 `app/menu.ts` から該当エントリを削除',
    '',
    `\`menuEntries\` 配列内の \`{ id: '${appId}', ... }\` エントリを削除。Edit ツールで対応。`,
    '',
    `#### 2.2 \`app/${appId}/\` ディレクトリを削除`,
    '',
    '```',
    `rm -rf app/${appId}/`,
    '```',
    '',
    '中には以下が含まれる想定:',
    '- `manifest.json`',
    '- `pages/*.tsx`',
    '- `api/*.ts`（独自アプリの場合）',
    '- `styles/*.css`',
    '- その他レシピ由来 / 独自作成のファイル',
    '',
    `#### 2.3 \`app/data/${appId}/\` ディレクトリを削除（存在する場合）`,
    '',
    '```',
    `rm -rf app/data/${appId}/`,
    '```',
    '',
    '中には以下が含まれる想定:',
    '- `_audit.log`（declarative handler の監査ログ）',
    '- `_kv.json`（KV ストア）',
    '- アプリ作成時にユーザーが投入した独自データ',
    '',
    '**注意**: ユーザーが大切にしているデータ（業務データ等）が含まれる可能性があるため、削除前に「`app/data/' +
      appId +
      '/` を削除してよいか」を再度確認すること。バックアップ提案も検討。',
    '',
    '### Step 3: 触ってはいけないもの',
    '',
    '以下は **絶対に削除しないこと**:',
    '',
    '- `src/` 配下（KB 本体コード）',
    '- `.claude/` 配下（Claude Code 設定）',
    '- `config/` 配下（KB 設定）',
    '- 他のアプリ（`app/<別 appId>/`）',
    '- `recipes/` 配下（リポジトリ内サンプルレシピ）',
    `- \`recipes-installed/\` 配下の **他 appId** のディレクトリ`,
    '- `recipe-history.json`（**康輔さん明示**: アプリ削除でレシピのインストール状態は更新しない）',
    '',
    ...(isRecipeSource
      ? [
          '### Step 4: レシピ由来アプリの注意',
          '',
          `manifest の \`source.type === 'recipe'\` です。`,
          '',
          `- \`recipes-installed/${appId}/manifest.json\` の削除は **任意**（dispatcher の scope 参照源だが、\`app/${appId}/\` 削除でアプリは動かなくなるので残骸として残しても害は少ない）`,
          `  - クリーンアップしたいなら \`rm -rf recipes-installed/${appId}/\` でよい`,
          '  - ただし `recipe-history.json` は **更新しない**（康輔さん仕様: 1 度でも install したらインストール済バッジ維持）',
          '',
        ]
      : []),
    '### Step 5: 完了報告',
    '',
    '削除作業完了後、ユーザーに以下を案内:',
    '',
    '- 削除したファイル一覧',
    `- サイドバーからアプリ「${displayName}」が消えたことの確認方法`,
    '  - 「ブラウザを再読み込みするか、KB が `app/menu.ts` の変更を検出すれば自動で消えます」',
    ...(isRecipeSource
      ? ['- レシピ由来アプリだった場合: 「同じレシピを再インストールしたい場合は、レシピ画面の『再インストール』ボタンから可能です」']
      : []),
    '',
    '---',
    '',
    '## 参考ドキュメント',
    '',
    '- `docs/agent-ref/05-apps.md` §10「アプリの削除」: 詳細な削除要綱',
    '- `docs/agent-ref/05-apps.md` §3「`app/` の構造」: 削除対象のディレクトリ構造の理解',
  ].join('\n')
}
