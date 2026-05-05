/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Logic-level tests for GlobalErrorBoundary.
 *
 * The component is a thin React class component; the parts worth
 * exercising are the static `getDerivedStateFromError` reducer and the
 * `componentDidCatch` side effect (which routes the error through the
 * renderer logger). We test those directly without spinning up React's
 * rendering pipeline, so this suite stays jsdom-free.
 *
 * The fallback UI rendering itself is verified at the E2E layer
 * (Playwright session-flow.spec.ts). If a future change adds
 * jsdom + @testing-library/react, the render path can be covered here
 * too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  // Stub `window` so the logger's transitive imports work in node.
  ;(globalThis as unknown as { window: { addEventListener: () => void } }).window = {
    addEventListener: () => undefined,
  }
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).window
})

describe('GlobalErrorBoundary / static getDerivedStateFromError', () => {
  it('returns { hasError: true } so the next render shows the fallback', async () => {
    const { GlobalErrorBoundary } = await import(
      '../../src/renderer/components/GlobalErrorBoundary'
    )
    const next = GlobalErrorBoundary.getDerivedStateFromError()
    expect(next).toEqual({ hasError: true })
  })
})

describe('GlobalErrorBoundary / componentDidCatch', () => {
  it('forwards the error to the logger via console.error and does NOT rethrow', async () => {
    const { GlobalErrorBoundary } = await import(
      '../../src/renderer/components/GlobalErrorBoundary'
    )
    // Construct the class. We never render — we just call
    // componentDidCatch as a unit.
    const instance = new GlobalErrorBoundary({ children: null })
    const err = new Error('render boom')
    err.name = 'TestError'

    expect(() =>
      instance.componentDidCatch(err, { componentStack: '<App/>\n<Page/>' }),
    ).not.toThrow()

    // The logger console-fallbacks to console.error for the 'error' level.
    expect(console.error).toHaveBeenCalled()
    const args = (console.error as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]
    expect(args[0]).toBe('[error-boundary] React render error caught by GlobalErrorBoundary')
    // Structured payload: err + componentStack
    const payload = args[1] as Record<string, unknown>
    expect(payload).toBeTruthy()
    expect((payload.err as Record<string, unknown>).message).toBe('render boom')
    expect((payload.err as Record<string, unknown>).name).toBe('TestError')
    expect(payload.componentStack).toBe('<App/>\n<Page/>')
  })
})
