/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * "Connect a Chrome extension" settings surface
 * (spec `chrome-extension-pairing-ui.md` v1.0).
 *
 * Issues a pairing code via the existing renderer-only endpoint
 * `POST /api/ext-pairing/issue` (§6.1, consumed as-is — no server change) and
 * displays it with a copy affordance + a TTL countdown driven by the server's
 * `ttlMs` (NOT a hardcoded 5 min, §7.3 / PR-3). The code lives in component
 * state only and is dropped on tab-away / unmount (§8.1 — never persisted).
 *
 * Defensive response validation (§6.1): a non-32-hex `pairingCode`, a
 * non-finite / non-positive `ttlMs` (NaN / Infinity rejected via
 * `Number.isFinite`), or a malformed body surfaces as `issueError` rather than
 * corrupting the display / countdown.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { kbFetch } from '../lib/kbFetch'
import { t } from '../i18n'
import { formatRemaining, parseIssueResponse, type IssuedCode } from './extensionPairingHelpers'

export function SettingsExtensionPairing() {
  const [issued, setIssued] = useState<IssuedCode | null>(null)
  const [generating, setGenerating] = useState(false)
  const [issueError, setIssueError] = useState(false)
  const [expired, setExpired] = useState(false)
  const [remainingMs, setRemainingMs] = useState(0)
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'error' | null>(null)

  // Generation counter to discard stale request completions (§7.1): a request
  // that resolves after unmount / re-generate must not call state setters.
  const requestGenRef = useRef(0)
  const mountedRef = useRef(true)
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the latest issued code so an async copy can tell whether the code
  // it wrote is still the one on screen after awaiting the clipboard.
  const issuedRef = useRef<IssuedCode | null>(null)
  issuedRef.current = issued

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  // Countdown loop (§7.3): self-scheduling setTimeout with a
  // `Math.min(1000, remainingMs)` delay so sub-second TTLs expire on time.
  useEffect(() => {
    if (!issued || expired) return
    clearCountdownTimer()

    const tick = () => {
      const remaining = Math.max(0, issued.expiresAt - Date.now())
      setRemainingMs(remaining)
      if (remaining <= 0) {
        setExpired(true)
        return
      }
      countdownTimerRef.current = setTimeout(tick, Math.min(1000, remaining))
    }
    tick()

    return clearCountdownTimer
  }, [issued, expired, clearCountdownTimer])

  // Cleanup all timers on unmount (§7.2 / §7.3) and invalidate in-flight
  // requests so late completions are ignored (§7.1).
  useEffect(() => {
    return () => {
      mountedRef.current = false
      requestGenRef.current += 1
      clearCountdownTimer()
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [clearCountdownTimer])

  const generate = useCallback(async () => {
    // Invalidate any prior in-flight request and start a new generation.
    requestGenRef.current += 1
    const gen = requestGenRef.current
    setGenerating(true)
    setIssueError(false)
    setExpired(false)
    // Clear any lingering copy feedback so a freshly issued code never shows
    // the previous code's "Copied" / error state.
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    setCopyFeedback(null)
    clearCountdownTimer()
    try {
      const res = await kbFetch('/api/ext-pairing/issue', { method: 'POST' })
      // Discard if a newer request started or the component unmounted.
      if (gen !== requestGenRef.current) return
      if (!res.ok) {
        setIssued(null)
        setIssueError(true)
        return
      }
      let body: unknown
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (gen !== requestGenRef.current) return
      const parsed = parseIssueResponse(body)
      if (!parsed) {
        setIssued(null)
        setIssueError(true)
        return
      }
      // Seed remainingMs synchronously so a fresh code never flashes
      // "Expires in 00:00" before the countdown effect runs after paint.
      setRemainingMs(Math.max(0, parsed.expiresAt - Date.now()))
      setIssued(parsed)
    } catch {
      if (gen !== requestGenRef.current) return
      setIssued(null)
      setIssueError(true)
    } finally {
      if (gen === requestGenRef.current) setGenerating(false)
    }
  }, [clearCountdownTimer])

  const copy = useCallback(async () => {
    if (!issued) return
    // Capture the code being copied so a write that resolves after the user
    // regenerated does not show "Copied" under a different, newly issued code
    // (the clipboard would still hold this captured code).
    const copiedCode = issued.pairingCode
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    let ok = false
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(copiedCode)
      ok = true
    } catch {
      ok = false
    }
    // Discard the result if the component unmounted (§7.2 no post-unmount
    // state update) or if the displayed code changed while writing (a
    // regenerate landed) — feedback must not attach to a different code.
    if (!mountedRef.current) return
    if (issuedRef.current?.pairingCode !== copiedCode) return
    setCopyFeedback(ok ? 'copied' : 'error')
    copyTimerRef.current = setTimeout(() => setCopyFeedback(null), 1500)
  }, [issued])

  const showCode = issued !== null && !expired

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-[var(--text-secondary)]">
          {t('setting.extensionPairing.title')}
        </h3>
        <p className="mt-1 text-sm text-[var(--text-dim)]">
          {t('setting.extensionPairing.description')}
        </p>
      </div>

      {!issued && !issueError && (
        <p className="text-sm text-[var(--text-dim)]">
          {t('setting.extensionPairing.regenerateHint')}
        </p>
      )}

      {issueError && (
        <p className="text-sm text-[var(--error-text,#f87171)]">
          {t('setting.extensionPairing.issueError')}
        </p>
      )}

      {showCode && issued && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg border border-[var(--border)] bg-[var(--bg-elevated,rgba(255,255,255,0.04))] px-3 py-2 font-mono text-sm text-[var(--text-secondary)]">
              {issued.pairingCode}
            </code>
            <button
              onClick={copy}
              className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
            >
              {copyFeedback === 'copied'
                ? t('setting.extensionPairing.copied')
                : copyFeedback === 'error'
                  ? t('setting.extensionPairing.copyError')
                  : t('setting.extensionPairing.copy')}
            </button>
          </div>
          <p className="text-sm text-[var(--text-dim)]">
            {t('setting.extensionPairing.expiresIn', { mmss: formatRemaining(remainingMs) })}
          </p>
          <p className="text-xs text-[var(--text-dim)]">
            {t('setting.extensionPairing.singleUseNote')}
          </p>
          <p className="text-xs text-[var(--text-dim)]">
            {t('setting.extensionPairing.replaceWarning')}
          </p>
          <p className="text-xs text-[var(--warning-text,#fbbf24)]">
            {t('setting.extensionPairing.phishingWarning')}
          </p>
        </div>
      )}

      {expired && (
        <p className="text-sm text-[var(--text-dim)]">{t('setting.extensionPairing.expired')}</p>
      )}

      <div>
        <button
          onClick={generate}
          disabled={generating}
          className="rounded-lg bg-[var(--accent,#6366f1)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 transition-colors"
        >
          {issued
            ? t('setting.extensionPairing.regenerate')
            : t('setting.extensionPairing.generate')}
        </button>
      </div>
    </div>
  )
}
