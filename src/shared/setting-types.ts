/** KovitoBoard 設定ファイル (.kovitoboard/setting.json) の型定義 */
export interface KovitoboardSetting {
  version: '1.1'
  user: {
    displayName: string
    avatar: string | null
  }
  project: {
    name: string
    description: string
    path: string  // プロジェクトルートの絶対パス (DEC-009)
  }
  locale: 'ja' | 'en'
  onboarding: {
    completedAt: string | null
    wizardVersion: string
  }
}
