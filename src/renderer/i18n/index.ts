import ja, { type MessageKey } from './ja'
import en from './en'

type Locale = 'ja' | 'en'

const catalogs: Record<Locale, Record<MessageKey, string>> = { ja, en }

let currentLocale: Locale = 'ja'

/** 現在のロケールを設定 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
}

/** 現在のロケールを取得 */
export function getLocale(): Locale {
  return currentLocale
}

/**
 * メッセージキーからローカライズされた文字列を取得。
 * プレースホルダー（{key}）は params で置換可能。
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
