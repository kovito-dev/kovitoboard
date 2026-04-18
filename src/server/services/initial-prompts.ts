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
