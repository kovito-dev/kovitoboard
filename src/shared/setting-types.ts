/** Type definition for the KovitoBoard settings file (.kovitoboard/setting.json) */
export interface KovitoboardSetting {
  version: '1.1'
  user: {
    displayName: string
    avatar: string | null
  }
  project: {
    name: string
    description: string
    path: string  // Absolute path to the project root (DEC-009)
  }
  locale: 'ja' | 'en'
  onboarding: {
    completedAt: string | null
    wizardVersion: string
  }
}
