/** KovitoBoard 設定ファイル (.kovitoboard/setting.json) の型定義 */
export interface KovitoboardSetting {
  version: '1.0'
  user: {
    displayName: string
    avatar: string | null
  }
  project: {
    name: string
    description: string
  }
  locale: 'ja' | 'en'
  onboarding: {
    completedAt: string | null
    wizardVersion: string
  }
}
