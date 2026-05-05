/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Upgrade prompt dictionary
 *
 * Holds the localized prompt body sent to the agent when the user
 * clicks "Update" on the version-display popover (spec
 * v0.1.0-version-display.md §6.2). Uses the same dictionary pattern
 * as initial-prompts.ts so the hygiene check treats this as a
 * locale-aware text store, not stray UI strings.
 */

interface PromptArgs {
  currentVersion: string
  latestVersion: string
}

const PROMPTS: Record<'ja' | 'en', (args: PromptArgs) => string> = {
  ja: ({ currentVersion, latestVersion }) =>
    [
      `KovitoBoard を v${currentVersion} から v${latestVersion} にアップデートしてください。`,
      '',
      '手順は `docs/agent-ref/10-upgrade.md` §3「バージョンアップ手順（標準フロー）」に従ってください。特に以下を必ず実施してください:',
      '',
      '1. §2「バージョンアップ前の準備」の事前点検（git status / app/ の状況 / インストール済みレシピ確認）',
      '2. §3 の標準フロー（git fetch → diff 概観 → conflict 可能性判定 → git pull → npm install）',
      '3. conflict が発生した場合は §4 に従って対処、不明点は私に確認',
      '4. 完了後、§5「バージョンアップ後の整合性確認」の項目を実行',
      '5. KB の再起動が必要であることを案内',
      '',
      '危険な操作（src/ 改変の上書き、未コミット変更の破棄など）の前には必ず私に確認してください。',
    ].join('\n'),

  en: ({ currentVersion, latestVersion }) =>
    [
      `Please upgrade KovitoBoard from v${currentVersion} to v${latestVersion}.`,
      '',
      'Follow `docs/agent-ref/10-upgrade.md` §3 ("standard upgrade flow"). In particular:',
      '',
      '1. Run the §2 pre-flight checks (git status / app/ state / installed recipes).',
      '2. Execute the §3 standard flow (git fetch → diff overview → conflict assessment → git pull → npm install).',
      '3. If a conflict appears, follow §4 and check with me before resolving anything risky.',
      '4. After the upgrade completes, run the §5 post-upgrade integrity checks.',
      '5. Tell me when KovitoBoard needs a restart.',
      '',
      'Confirm with me before any destructive operation (overwriting modified `src/` files, discarding uncommitted work, etc.).',
    ].join('\n'),
}

/** Build the user-facing upgrade prompt for the given locale. */
export function buildUpgradePrompt(args: PromptArgs & { locale: 'ja' | 'en' }): string {
  const builder = PROMPTS[args.locale] ?? PROMPTS['ja']
  return builder({ currentVersion: args.currentVersion, latestVersion: args.latestVersion })
}
