/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import { GlobalErrorBoundary } from './components/GlobalErrorBoundary'
import { setupGlobalErrorHandlers } from './lib/global-errors'
import { installAmbientKbBridge } from './app-host/installAmbientKbBridge'
import { bootstrapLocaleFromSetting } from './lib/locale-bootstrap'
import { getLocale } from './i18n'
import './styles/index.css'

// DEC-017 v1.2: install global error handlers before React mounts so
// any error thrown during initial render is captured and forwarded to
// the structured logger.
setupGlobalErrorHandlers()

// DEC-020 / EU8 §2.4 β-method: bootstrap the app-wide
// `window.kb.exposeContext` channel. Recipe-page mounts later layer
// `call` and `log` on top via app-host/injectKb.ts.
installAmbientKbBridge()

/**
 * Bootstrap the locale from the server-side `setting.json` *before*
 * importing `./App`. This matters because App.tsx (and other
 * components) build module-level constants such as `menuEntries`,
 * RecipesPage `TABS`, and SettingsModal `TABS` by calling `t(...)` at
 * module evaluation. If we imported `./App` synchronously at the top,
 * those constants would be locked to whatever locale `i18n/index.ts`
 * resolved purely from `localStorage` — which is empty for users who
 * onboarded before locale persistence landed (`db023ee`), in privacy
 * mode, or in a different browser. Awaiting the bootstrap fetch and
 * then dynamically importing `./App` lets `setLocale()` run first so
 * the module-level `t(...)` calls pick up the server's authoritative
 * `locale` on the very first paint.
 *
 * Failures inside `bootstrapLocaleFromSetting()` are swallowed; the
 * renderer falls through to the localStorage / OSS-fallback path so
 * the UI still mounts even when the API is unreachable.
 */
async function main() {
  await bootstrapLocaleFromSetting()

  // Mirror the resolved locale onto `<html lang>` so screen readers
  // and browser features (hyphenation, font selection) match the
  // rendered copy. The static value in `index.html` is just a
  // placeholder for the pre-bootstrap moment.
  document.documentElement.lang = getLocale()

  const { App } = await import('./App')
  const root = document.getElementById('root')!
  createRoot(root).render(
    <GlobalErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </GlobalErrorBoundary>,
  )
}

void main()
