/**
 * エージェントアバター画像の優先順位解決ロジック
 *
 * ファイルシステムを走査して custom -> default の順で画像を探す。
 * - custom: ユーザーがアップロードした画像（public/avatars/custom/）
 * - default: 既定アバター（public/avatars/default/、git 管理）
 * - どちらにもなければ null（フロントエンド側の SVG 生成器がフォールバック）
 */

import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from '../fs-layer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPPORTED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg']

/**
 * avatars ディレクトリのパスを解決する。
 * dev: src/server/services/ -> ../../../public/avatars
 * build: dist/server/services/ -> ../../avatars (dist/ に vite がコピーした public)
 *
 * ただし dev 時はビルド済み dist がないため ../../public/avatars にもフォールバック
 */
function getAvatarsBaseDir(fs: FileAccessLayer): string {
  const candidates = [
    resolve(__dirname, '../../../public/avatars'),  // dev
    resolve(__dirname, '../../avatars'),             // build (dist/avatars/)
  ]
  return candidates.find(d => fs.existsSync(d)) || candidates[0]
}

export function getCustomDir(fs: FileAccessLayer): string {
  return join(getAvatarsBaseDir(fs), 'custom')
}

export function getDefaultDir(fs: FileAccessLayer): string {
  return join(getAvatarsBaseDir(fs), 'default')
}

/**
 * エージェント名に対応するアバター画像パスを解決する。
 * custom -> default の順で探す。見つからなければ null。
 */
export function resolveAvatarPath(fs: FileAccessLayer, agentName: string): string | null {
  // custom ディレクトリを先に探す
  const customDir = getCustomDir(fs)
  const customPath = findImageInDir(fs, customDir, agentName)
  if (customPath) return customPath

  // default ディレクトリ
  const defaultDir = getDefaultDir(fs)
  return findImageInDir(fs, defaultDir, agentName)
}

/**
 * 指定ディレクトリ内で agentName.{ext} にマッチするファイルを探す
 */
function findImageInDir(fs: FileAccessLayer, dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null
  for (const ext of SUPPORTED_EXTS) {
    const filePath = join(dir, `${name}${ext}`)
    if (fs.existsSync(filePath)) return filePath
  }
  return null
}

/**
 * custom ディレクトリ内の agentName.* を全削除（拡張子違いも含む）
 */
export function deleteCustomAvatar(fs: FileAccessLayer, agentName: string): boolean {
  const customDir = getCustomDir(fs)
  if (!fs.existsSync(customDir)) return false

  let deleted = false
  for (const ext of SUPPORTED_EXTS) {
    const filePath = join(customDir, `${agentName}${ext}`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      deleted = true
    }
  }
  return deleted
}
