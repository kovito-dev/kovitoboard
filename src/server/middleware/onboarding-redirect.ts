/**
 * Redirect middleware for incomplete onboarding
 *
 * When .kovitoboard/setting.json onboarding.completedAt is not set,
 * redirects HTML page requests to /onboarding.
 * API, static asset, and WebSocket requests are passed through.
 */
import type { Request, Response, NextFunction } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { readSetting } from '../setting-manager'

/**
 * Create the onboarding redirect middleware.
 * Must be applied **before** the SPA fallback handler.
 */
export function createOnboardingRedirect(fs: FileAccessLayer) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Pass through API, WebSocket, and static asset requests
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api') ||
      req.path.startsWith('/ws') ||
      req.path.startsWith('/assets') ||
      req.path.startsWith('/avatars') ||
      req.path.includes('.')  // Static files (.js, .css, .svg, etc.)
    ) {
      next()
      return
    }

    // Pass through if already on the onboarding page
    if (req.path === '/onboarding' || req.path.startsWith('/onboarding')) {
      next()
      return
    }

    // Read settings; pass through if onboarding is already completed
    const setting = readSetting(fs)
    if (setting?.onboarding?.completedAt) {
      next()
      return
    }

    // Not completed — redirect to /onboarding
    res.redirect(302, '/onboarding')
  }
}
