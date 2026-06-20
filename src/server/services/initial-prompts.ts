/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Initial prompt template dictionary
 *
 * Manages predefined messages used during onboarding, etc.,
 * organized by locale.
 */

/** Initial prompt template dictionary */
const INITIAL_PROMPTS: Record<string, Record<'ja' | 'en', string>> = {
  'onboarding:first-time': {
    ja: 'はじめまして！今から一緒に KovitoBoard を使い始めましょう。',
    en: 'Welcome! Let\'s get started with KovitoBoard together.',
  },
  'security:add-deny-pattern': {
    ja:
      'KovitoBoard の推奨設定に従い、Claude Code の権限設定に `.kovitoboard/` を deny pattern として追加してください。\n\n' +
      '手順:\n' +
      '1. プロジェクトの `.claude/settings.json`（プロジェクト全体に適用する場合）または ' +
      'ユーザーの `~/.claude/settings.json`（全プロジェクトに適用する場合）を開いてください。\n' +
      '2. `permissions.deny` 配列に `.kovitoboard/**` を追加してください（`.kovitoboard/` でも可）。' +
      'ファイルが無い場合や `permissions` キーが無い場合は新規に作成してください。\n' +
      '3. 設定例:\n' +
      '```json\n' +
      '{\n' +
      '  "permissions": {\n' +
      '    "deny": [".kovitoboard/**"]\n' +
      '  }\n' +
      '}\n' +
      '```\n' +
      '`Read(.kovitoboard/**)` のようなアクション限定の書き方は使わないでください。' +
      '1 種類のアクションしか塞がず、書き込み系のアクセスが残ってしまいます。\n' +
      '4. 上の例は最小構成です。`.claude/settings.json` には他の重要な設定' +
      '（`permissions.allow`、既存の `deny`、`hooks`、`env` など）が含まれている場合があります。' +
      'ファイル全体を置き換えず、既存のキーと値をすべて保持したまま、' +
      '`permissions.deny` 配列に `.kovitoboard/**` を 1 要素追記するだけにしてください。\n\n' +
      'これにより、KovitoBoard の内部状態ディレクトリへの意図しないアクセスを防げます。',
    en:
      'Following KovitoBoard\'s recommended settings, please add `.kovitoboard/` to ' +
      'Claude Code\'s deny pattern in its permission settings.\n\n' +
      'Steps:\n' +
      '1. Open the project `.claude/settings.json` (to apply to this project) or the ' +
      'user `~/.claude/settings.json` (to apply to all projects).\n' +
      '2. Add `.kovitoboard/**` to the `permissions.deny` array (`.kovitoboard/` also works). ' +
      'Create the file or the `permissions` key if they do not exist yet.\n' +
      '3. Example settings:\n' +
      '```json\n' +
      '{\n' +
      '  "permissions": {\n' +
      '    "deny": [".kovitoboard/**"]\n' +
      '  }\n' +
      '}\n' +
      '```\n' +
      'Do not use an action-scoped form such as `Read(.kovitoboard/**)`: it only ' +
      'blocks one action class and leaves write-capable access open.\n' +
      '4. The example above is minimal. Your `.claude/settings.json` may already ' +
      'contain other important settings (such as `permissions.allow`, an existing ' +
      '`deny`, `hooks`, or `env`). Do not replace the whole file: preserve every ' +
      'existing key and value, and only append the single `.kovitoboard/**` entry ' +
      'to the `permissions.deny` array.\n\n' +
      'This prevents unintended access to KovitoBoard\'s internal state directory.',
  },
}

/**
 * Return the initial prompt template for the given key and locale.
 * Returns null if the key does not exist.
 * Falls back to 'ja' if the specified locale is not available.
 */
export function getInitialPrompt(key: string, locale: 'ja' | 'en'): string | null {
  const entry = INITIAL_PROMPTS[key]
  if (!entry) return null
  return entry[locale] ?? entry['ja'] ?? null
}
