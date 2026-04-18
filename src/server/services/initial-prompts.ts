/**
 * 初回発話テンプレート辞書
 *
 * オンボーディング等で使用する定型メッセージを
 * ロケール別に管理する。
 */

/** 初回発話テンプレート辞書 */
const INITIAL_PROMPTS: Record<string, Record<'ja' | 'en', string>> = {
  'onboarding:first-time': {
    ja: 'はじめまして！今から一緒に KovitoBoard を使い始めましょう。',
    en: 'Welcome! Let\'s get started with KovitoBoard together.',
  },
}

/**
 * 指定キー・ロケールの初回発話テンプレートを返す。
 * 該当キーが存在しない場合は null を返す。
 * 指定ロケールが存在しない場合は 'ja' にフォールバックする。
 */
export function getInitialPrompt(key: string, locale: 'ja' | 'en'): string | null {
  const entry = INITIAL_PROMPTS[key]
  if (!entry) return null
  return entry[locale] ?? entry['ja'] ?? null
}
