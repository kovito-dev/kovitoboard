/**
 * KovitoBoard 設定ファイル (.kovitoboard/setting.json) の読み書き
 *
 * FileAccessLayer を受け取る設計。
 * バリデーションは手書きで実装する（zod 不使用）。
 */
import { join } from 'path'
import { getKovitoboardDir } from './paths'
import type { FileAccessLayer } from './fs-layer'
import type { KovitoboardSetting } from '../shared/setting-types'

const SETTING_FILENAME = 'setting.json'

/** .kovitoboard/setting.json のパスを返す */
export function getSettingPath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), SETTING_FILENAME)
}

/** 設定ファイルを読み込む。ファイルが無ければ null を返す */
export function readSetting(fs: FileAccessLayer): KovitoboardSetting | null {
  const settingPath = getSettingPath(fs)
  if (!fs.existsSync(settingPath)) return null

  try {
    const raw = fs.readFileSync(settingPath, 'utf-8')
    const data: unknown = JSON.parse(raw)
    if (!validateSetting(data)) {
      console.warn('[setting-manager] Invalid setting file, returning null')
      return null
    }
    return data
  } catch (err) {
    console.error('[setting-manager] Failed to read setting:', err)
    return null
  }
}

/** 設定ファイルを JSON で書き出す */
export function writeSetting(fs: FileAccessLayer, data: KovitoboardSetting): void {
  const settingPath = getSettingPath(fs)

  // .kovitoboard/ ディレクトリがなければ作成
  const dir = getKovitoboardDir(fs)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(settingPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** 手書きバリデーション（zod 不使用） */
export function validateSetting(data: unknown): data is KovitoboardSetting {
  if (data === null || typeof data !== 'object') return false

  const obj = data as Record<string, unknown>

  // version
  if (obj.version !== '1.0') return false

  // user
  if (obj.user === null || typeof obj.user !== 'object') return false
  const user = obj.user as Record<string, unknown>
  if (typeof user.displayName !== 'string') return false
  if (user.avatar !== null && typeof user.avatar !== 'string') return false

  // project
  if (obj.project === null || typeof obj.project !== 'object') return false
  const project = obj.project as Record<string, unknown>
  if (typeof project.name !== 'string') return false
  if (typeof project.description !== 'string') return false

  // locale
  if (obj.locale !== 'ja' && obj.locale !== 'en') return false

  // onboarding
  if (obj.onboarding === null || typeof obj.onboarding !== 'object') return false
  const onboarding = obj.onboarding as Record<string, unknown>
  if (onboarding.completedAt !== null && typeof onboarding.completedAt !== 'string') return false
  if (typeof onboarding.wizardVersion !== 'string') return false

  return true
}
