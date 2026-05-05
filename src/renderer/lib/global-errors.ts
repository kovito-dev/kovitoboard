/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Global error capture (DEC-017 v1.2 §10, design §13.7).
 *
 * Wires `window.error` and `window.unhandledrejection` to the
 * structured logger so uncaught exceptions and rejected promises
 * land in the same `.kovitoboard/logs/server.*.log` JSON Lines file
 * as server-side logs.
 *
 * Critical compatibility note (Playwright):
 *
 *   We intentionally do NOT call `event.preventDefault()` on either
 *   handler. `preventDefault()` would suppress the browser's default
 *   "uncaught" routing and, in particular, prevent Playwright's
 *   `page.on('pageerror')` from firing.
 *
 *   The kovitoboard L1 test suite relies on `pageerror` in
 *   `tests/e2e/session-flow.spec.ts` (L52, L77) to assert that no
 *   render-time errors occur during the session flow. Calling
 *   `preventDefault()` here would silently break those assertions.
 *
 * The handlers are idempotent — calling `setupGlobalErrorHandlers()`
 * twice (e.g. via Vite HMR) does not double-register; we track an
 * internal flag so the second call is a no-op.
 */
import { createLogger } from './logger'

const log = createLogger('global-errors')

let installed = false

export function setupGlobalErrorHandlers(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    log.error(
      {
        err: {
          message: event.message,
          source: event.filename,
          line: event.lineno,
          col: event.colno,
        },
        stack: event.error?.stack,
      },
      'Uncaught error',
    )
    // Do NOT preventDefault — see file header.
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const errPayload =
      reason instanceof Error
        ? {
            message: reason.message,
            stack: reason.stack,
            name: reason.name,
          }
        : { message: String(reason) }
    log.error({ err: errPayload }, 'Unhandled promise rejection')
    // Do NOT preventDefault — see file header.
  })
}

/**
 * Test-only: reset the install flag so unit tests can re-arm the
 * handlers across test cases.
 */
export function _resetGlobalErrorsForTests(): void {
  installed = false
}
