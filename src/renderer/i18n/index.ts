import ja, { type MessageKey } from './ja'
import en from './en'

type Locale = 'ja' | 'en'

const catalogs: Record<Locale, Record<MessageKey, string>> = { ja, en }

let currentLocale: Locale = 'ja'

/** Set the current locale */
export function setLocale(locale: Locale): void {
  currentLocale = locale
}

/** Get the current locale */
export function getLocale(): Locale {
  return currentLocale
}

/**
 * Retrieve a localized string by message key.
 * Placeholders ({key}) can be substituted via the params argument.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const catalog = catalogs[currentLocale] || catalogs['ja']
  let message = catalog[key] ?? ja[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      message = message.replace(`{${k}}`, String(v))
    }
  }
  return message
}

export type { MessageKey, Locale }
