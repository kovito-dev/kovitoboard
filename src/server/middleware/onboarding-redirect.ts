/**
 * オンボーディング未完了時のリダイレクトミドルウェア
 *
 * .kovitoboard/setting.json の onboarding.completedAt が未設定の場合、
 * HTML ページリクエストを /onboarding にリダイレクトする。
 * API・静的アセット・WebSocket リクエストはスルーする。
 */
import type { Request, Response, NextFunction } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { readSetting } from '../setting-manager'

/**
 * オンボーディングリダイレクトミドルウェアを生成する。
 * SPA フォールバックの **前** に適用する。
 */
export function createOnboardingRedirect(fs: FileAccessLayer) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // API・WebSocket・静的アセットはスルー
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api') ||
      req.path.startsWith('/ws') ||
      req.path.startsWith('/assets') ||
      req.path.startsWith('/avatars') ||
      req.path.includes('.')  // 静的ファイル（.js, .css, .svg 等）
    ) {
      next()
      return
    }

    // 既にオンボーディングページにいる場合はスルー
    if (req.path === '/onboarding' || req.path.startsWith('/onboarding')) {
      next()
      return
    }

    // 設定を読み取り、完了済みならスルー
    const setting = readSetting(fs)
    if (setting?.onboarding?.completedAt) {
      next()
      return
    }

    // 未完了 → /onboarding にリダイレクト
    res.redirect(302, '/onboarding')
  }
}
