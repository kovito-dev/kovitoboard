/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Work Roots settings surface (spec `cwd-allowlist.md` v1.0 §7.4).
 *
 * Lets the user inspect / extend / shrink the cwd allow-list. The
 * UI is intentionally minimal for v0.2.0:
 *
 *   - Path entry is a text input that expects an absolute path.
 *     A native folder picker would be ideal but the File System
 *     Access API is Chromium-only and electron-only; the browser
 *     `<input type="file" webkitdirectory>` reports basenames, not
 *     absolute paths. v0.3.x is expected to ship a richer picker
 *     once we know the install footprint (BL observation).
 *   - Delete asks for confirmation via the shared `ConfirmModal`
 *     because removal can immediately break in-flight `claude`
 *     sessions running under that root (§7.6 lifecycle).
 *
 * Error envelope: the endpoint returns
 * `{ error, message, path }` per §6.2.2; we surface `message`
 * verbatim. The error code is shown alongside as a developer aid
 * but kept terse so the human-readable copy carries the main
 * weight.
 *
 * v0.2.1 BL-2026-167: extracted from `WorkRootsPage.tsx` so the
 * same surface can mount inside the Settings modal's `workRoots`
 * tab (judgement doc v1.1 §2.1 case A / §2.2 case B-1). The
 * legacy `/work-roots` route stays alive via a thin wrapper in
 * `pages/WorkRootsPage.tsx` to preserve deep-link / e2e
 * compatibility (§2.4 #4). ProjectRootBanner is embedded at the
 * top of this surface (§2.3 case C-1) — the nav-rail mount in
 * `App.tsx` is intentionally left in place; the duplicate is
 * accepted so the project-root context stays visible regardless
 * of how the user reached the settings tab.
 */
import { useEffect, useState } from 'react'
import { ConfirmModal } from './ConfirmModal'
import { ProjectRootBanner } from './ProjectRootBanner'
import { kbFetch } from '../lib/kbFetch'
import { t } from '../i18n'

interface WorkRootsResponse {
  additionalWorkRoots: string[]
}

interface ErrorBody {
  error: string
  message: string
  path?: unknown
}

export function SettingsWorkRoots() {
  const [roots, setRoots] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // Dedicated load-error state so a failed initial fetch is not
  // rendered as "no additional work roots yet" (CodeX PR #38
  // Attempt 8 LOW 2 — a 401 / 403 / 500 had been collapsing into
  // the empty-state copy and hiding operational/auth issues).
  const [loadError, setLoadError] = useState<boolean>(false)
  const [inputPath, setInputPath] = useState('')
  const [addError, setAddError] = useState<ErrorBody | null>(null)
  const [adding, setAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<ErrorBody | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Initial fetch of the current allow-list.
  useEffect(() => {
    let cancelled = false
    kbFetch('/api/work-roots')
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) {
            setRoots([])
            setLoadError(true)
          }
          return
        }
        const body = (await res.json()) as WorkRootsResponse
        if (cancelled) return
        setRoots(body.additionalWorkRoots ?? [])
      })
      .catch(() => {
        if (!cancelled) {
          setRoots([])
          setLoadError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleAdd() {
    setAddError(null)
    setAdding(true)
    try {
      const res = await kbFetch('/api/work-roots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: inputPath.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json()) as ErrorBody
        setAddError(body)
        return
      }
      const body = (await res.json()) as {
        addedPath: string
        additionalWorkRoots: string[]
      }
      setRoots(body.additionalWorkRoots ?? [])
      setInputPath('')
      // A successful mutation proves the server is reachable and
      // returned an authoritative roots list, so clear the
      // initial-load banner. Without this clear, a transient load
      // failure would keep the load-error UI stuck forever even
      // after the user successfully adds a root (CodeX PR #38
      // Attempt 12 LOW 2).
      setLoadError(false)
    } catch (err) {
      setAddError({
        error: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(path: string) {
    setDeleteError(null)
    setDeleting(true)
    try {
      const res = await kbFetch('/api/work-roots', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (!res.ok) {
        const body = (await res.json()) as ErrorBody
        setDeleteError(body)
        return
      }
      const body = (await res.json()) as {
        removedPath: string
        additionalWorkRoots: string[]
      }
      setRoots(body.additionalWorkRoots ?? [])
      setPendingDelete(null)
      // Same recovery as the add path — a successful mutation
      // clears the stale load-error banner (CodeX PR #38 Attempt
      // 12 LOW 2).
      setLoadError(false)
    } catch (err) {
      setDeleteError({
        error: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-[var(--bg-primary)]">
      {/* ProjectRootBanner ships with `mt-auto` so it pins to the
          bottom of the nav rail in its canonical mount. Wrapping it
          in a non-flex container localises the `mt-auto` so it has no
          effect here, letting the banner render at the very top of
          the settings surface (judgement doc v1.1 §2.3 case C-1).
          The banner component itself is intentionally left unchanged
          (touch list #3 in the implementation request). */}
      <div className="shrink-0">
        <ProjectRootBanner compact={false} />
      </div>

      <div className="max-w-3xl w-full mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold mb-2 text-[var(--text-primary)]">
          {t('workRoots.title')}
        </h1>
        <p className="text-sm text-[var(--text-dim)] mb-6">
          {t('workRoots.description')}
        </p>

        {/* Add new work root */}
        <section className="mb-8 border border-[var(--border)] rounded-lg p-4 bg-[var(--bg-secondary)]">
          <h2 className="text-base font-medium mb-3 text-[var(--text-primary)]">
            {t('workRoots.addSection.title')}
          </h2>
          <p className="text-xs text-[var(--text-dim)] mb-3">
            {t('workRoots.addSection.help')}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={inputPath}
              onChange={(e) => setInputPath(e.target.value)}
              placeholder="/absolute/path/to/work-root"
              className="flex-1 px-3 py-2 rounded bg-[var(--bg-input)] border border-[var(--border)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-border)]"
              disabled={adding}
              data-testid="work-roots-input"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding || inputPath.trim().length === 0}
              className="px-4 py-2 rounded bg-[var(--accent-bg)] text-[var(--accent-text)] text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              data-testid="work-roots-add-button"
            >
              {adding ? t('workRoots.adding') : t('workRoots.addButton')}
            </button>
          </div>
          {addError && (
            <div
              className="mt-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-sm text-red-300"
              data-testid="work-roots-add-error"
            >
              <div className="font-medium">{addError.message}</div>
              <div className="text-xs text-[var(--text-dim)] mt-0.5">
                {t('workRoots.errorCodeLabel')}: <code>{addError.error}</code>
              </div>
            </div>
          )}
        </section>

        {/* Existing roots list */}
        <section>
          <h2 className="text-base font-medium mb-3 text-[var(--text-primary)]">
            {t('workRoots.listSection.title')}
          </h2>
          {loading ? (
            <div className="text-sm text-[var(--text-dim)]">
              {t('common.loading')}
            </div>
          ) : loadError ? (
            <div
              className="text-sm px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300"
              data-testid="work-roots-load-error"
            >
              {t('workRoots.listSection.loadError')}
            </div>
          ) : roots.length === 0 ? (
            <div
              className="text-sm text-[var(--text-dim)] italic"
              data-testid="work-roots-empty"
            >
              {t('workRoots.listSection.empty')}
            </div>
          ) : (
            <ul
              className="space-y-2"
              data-testid="work-roots-list"
            >
              {roots.map((root) => (
                <li
                  key={root}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg-secondary)]"
                  data-testid="work-roots-item"
                >
                  <code className="text-sm text-[var(--text-primary)] truncate">{root}</code>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(root)}
                    className="px-3 py-1 rounded text-xs text-red-300 hover:bg-red-500/10 border border-red-500/30 transition-colors"
                    data-testid="work-roots-delete-button"
                  >
                    {t('common.delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {deleteError && (
            <div
              className="mt-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-sm text-red-300"
              data-testid="work-roots-delete-error"
            >
              <div className="font-medium">{deleteError.message}</div>
              <div className="text-xs text-[var(--text-dim)] mt-0.5">
                {t('workRoots.errorCodeLabel')}: <code>{deleteError.error}</code>
              </div>
            </div>
          )}
        </section>
      </div>

      <ConfirmModal
        isOpen={pendingDelete !== null}
        title={t('workRoots.deleteConfirm.title')}
        body={
          <div className="text-sm">
            <p className="mb-2">{t('workRoots.deleteConfirm.body')}</p>
            <code className="block px-2 py-1 rounded bg-[var(--bg-elevated)] text-xs text-[var(--text-primary)] break-all">
              {pendingDelete ?? ''}
            </code>
          </div>
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        loading={deleting}
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete)
        }}
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
      />
    </div>
  )
}
