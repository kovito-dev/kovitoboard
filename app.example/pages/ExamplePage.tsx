/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect } from 'react'
import { createLogger } from '../../src/renderer/lib/logger'

// app/pages/* components are loaded outside the recipe lifecycle,
// so window.kb is undefined here. We grab a logger directly with
// the `app.<name>.*` namespace required by DEC-017 v1.3 §11 — the
// `app.` prefix is normally added by injectKb / kbContext, but we
// spell it out explicitly here because there is no platform layer
// in front of us. (For recipe-mounted pages, prefer window.kb.log.)
const log = createLogger('app.example.ExamplePage')

/**
 * Example extension page.
 *
 * - Must use `export default` (required by React.lazy)
 * - Use CSS variables (e.g., var(--text-primary)) for theme compatibility
 * - Tailwind CSS classes are available
 */
export default function ExamplePage() {
  const [apiData, setApiData] = useState<{ message: string; timestamp: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ext/example')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(setApiData)
      .catch((err) => {
        log.error({ err }, 'Failed to fetch example API')
        setError(err.message)
      })
  }, [])

  return (
    <div className="flex-1 p-6">
      <h1 className="text-xl font-bold text-[var(--text-primary)] mb-4">
        Example Page
      </h1>
      <p className="text-[var(--text-secondary)] mb-6">
        This page is an extension example in the <code className="text-[var(--accent-text)]">app/</code> directory.
        You can add custom pages without modifying <code className="text-[var(--accent-text)]">src/</code>.
      </p>

      <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
          API Response (/api/ext/example)
        </h2>
        {error && (
          <p className="text-red-400 text-sm">Error: {error}</p>
        )}
        {apiData && (
          <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">
            {JSON.stringify(apiData, null, 2)}
          </pre>
        )}
        {!apiData && !error && (
          <p className="text-[var(--text-dim)] text-sm">Loading...</p>
        )}
      </div>
    </div>
  )
}
