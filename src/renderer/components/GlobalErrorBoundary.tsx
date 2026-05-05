/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'
import { createLogger } from '../lib/logger'

const log = createLogger('error-boundary')

interface Props {
  children: ReactNode
}
interface State {
  hasError: boolean
  /** Captured render error. Kept in state so the diagnostic block can
   *  surface its message / stack for triage by a Claude Code agent. */
  error: Error | null
  /** React-provided component stack. Useful for narrowing the error
   *  source down to a specific component subtree. */
  componentStack: string | null
  /** Tri-state for the copy-to-clipboard button so we can surface a
   *  short "copied" / "copy failed" hint without bringing in a toast. */
  copyState: 'idle' | 'copied' | 'failed'
}

/**
 * Root-level React Error Boundary (DEC-017 v1.2 §10, design §13.6).
 *
 * Catches render-time exceptions in the descendant tree, forwards the
 * structured error to the logger (so it lands in the same JSON Lines
 * file as server-side logs), and renders a recovery-oriented fallback
 * UI:
 *   - Tells the user that the most likely cause is a stopped KB
 *     server and how to recover.
 *   - Offers a one-click reload.
 *   - Surfaces a copy-able diagnostic block (the error message, stack,
 *     URL, timestamp, user agent) preformatted as a prompt the user
 *     can hand to their Claude Code agent for further triage.
 *
 * Inline styles are intentional: the boundary may catch errors that
 * happen *before* the CSS bundle is fully loaded, so depending on
 * Tailwind classes here would risk a blank fallback.
 *
 * Intentionally does NOT rethrow — rethrowing would propagate the
 * error to `window.onerror` and create a feedback loop with
 * `setupGlobalErrorHandlers()`. Letting the boundary swallow the
 * exception (after logging) keeps the page interactive enough for the
 * user to reload, and matches the "do not preventDefault" rule that
 * preserves Playwright `page.on('pageerror')` test compatibility.
 */
export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    componentStack: null,
    copyState: 'idle',
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    log.error(
      {
        err: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
        componentStack: errorInfo.componentStack,
      },
      'React render error caught by GlobalErrorBoundary',
    )
    this.setState({
      componentStack: errorInfo.componentStack ?? null,
    })
    // Do not rethrow.
  }

  /** Build the multi-line diagnostic block that the user can paste
   *  into a Claude Code agent. Kept human-readable so the agent can
   *  parse it without extra tooling. */
  private buildDiagnosticMessage(): string {
    const error = this.state.error
    const lines: string[] = [
      t('error.boundary.diag.promptHeader'),
      '',
      `Time: ${new Date().toISOString()}`,
      typeof window !== 'undefined' ? `URL: ${window.location.href}` : 'URL: (unknown)',
      typeof navigator !== 'undefined' ? `User Agent: ${navigator.userAgent}` : 'User Agent: (unknown)',
      '',
      `Error name: ${error?.name ?? '(unknown)'}`,
      `Error message: ${error?.message ?? '(unknown)'}`,
      '',
      'Error stack:',
      error?.stack ?? '(no stack captured)',
    ]
    if (this.state.componentStack) {
      lines.push('', 'Component stack:', this.state.componentStack.trim())
    }
    return lines.join('\n')
  }

  private handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }

  private handleCopyDiagnostic = async (): Promise<void> => {
    const text = this.buildDiagnosticMessage()
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // Older / non-secure-context browsers fall back to the
        // legacy execCommand path. Document selection is intentional
        // so the user can also paste manually if execCommand fails.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('execCommand copy returned false')
      }
      this.setState({ copyState: 'copied' })
      setTimeout(() => this.setState({ copyState: 'idle' }), 2000)
    } catch (err) {
      log.warn({ err }, 'Failed to copy diagnostic message')
      this.setState({ copyState: 'failed' })
      setTimeout(() => this.setState({ copyState: 'idle' }), 4000)
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children
    }

    const diagnostic = this.buildDiagnosticMessage()
    const copyLabel =
      this.state.copyState === 'copied'
        ? t('error.boundary.button.copied')
        : this.state.copyState === 'failed'
          ? t('error.boundary.button.copyFailed')
          : t('error.boundary.button.copyDiag')

    return (
      <div
        role="alert"
        data-testid="global-error-fallback"
        style={{
          padding: '24px 20px',
          maxWidth: 760,
          margin: '40px auto',
          fontFamily: 'system-ui, sans-serif',
          color: '#1f2937',
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
          lineHeight: 1.6,
        }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600 }}>
          {t('error.boundary.title')}
        </h2>
        <p style={{ margin: '0 0 16px', color: '#374151' }}>
          {t('error.boundary.intro')}
        </p>

        <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
          {t('error.boundary.steps.heading')}
        </p>
        <ol style={{ margin: '0 0 20px', paddingLeft: 20, color: '#374151' }}>
          <li style={{ marginBottom: 8 }}>{t('error.boundary.steps.serverCheck')}</li>
          <li style={{ marginBottom: 8 }}>{t('error.boundary.steps.reload')}</li>
          <li>{t('error.boundary.steps.askAgent')}</li>
        </ol>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          <button
            type="button"
            data-testid="global-error-fallback-reload"
            onClick={this.handleReload}
            style={{
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: 500,
              color: '#ffffff',
              background: '#2563eb',
              border: '1px solid #1d4ed8',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            {t('error.boundary.button.reload')}
          </button>
          <button
            type="button"
            data-testid="global-error-fallback-copy"
            onClick={this.handleCopyDiagnostic}
            aria-live="polite"
            style={{
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: 500,
              color: this.state.copyState === 'failed' ? '#b91c1c' : '#1f2937',
              background: this.state.copyState === 'copied' ? '#d1fae5' : '#f3f4f6',
              border: '1px solid #d1d5db',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            {copyLabel}
          </button>
        </div>

        <div>
          <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#4b5563' }}>
            {t('error.boundary.diag.heading')}
          </p>
          <pre
            data-testid="global-error-fallback-diag"
            style={{
              margin: 0,
              padding: 12,
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              color: '#111827',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 320,
              overflow: 'auto',
            }}
          >
            {diagnostic}
          </pre>
        </div>
      </div>
    )
  }
}
