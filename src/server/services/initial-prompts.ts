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
      '    "deny": ["Read(.kovitoboard/**)"]\n' +
      '  }\n' +
      '}\n' +
      '```\n' +
      '4. 既存の `permissions.deny` がある場合は、その値を保ったまま `.kovitoboard/**` を追記してください。\n\n' +
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
      '    "deny": ["Read(.kovitoboard/**)"]\n' +
      '  }\n' +
      '}\n' +
      '```\n' +
      '4. If a `permissions.deny` entry already exists, keep its current values and append `.kovitoboard/**`.\n\n' +
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
