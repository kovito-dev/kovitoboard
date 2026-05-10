/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * ProjectRootBanner — pinned-to-the-bottom display of the supervisor's
 * resolved project root.
 *
 * Spec: `process-lifecycle.md` v1.2 §3 / `shared-installation-prevention-request.md`
 * §M-3 (in the kovitoboard-dev workspace). The embedded deployment
 * model expects the supervisor to be anchored on a specific Claude
 * Code project root; surfacing that path in the chrome lets operators
 * spot a misdirected launch (typically a cwd-fallback) at a glance.
 *
 * The banner is intentionally narrow scope: it reads
 * `/api/config/project-root` once on mount, renders the path with
 * `~` collapsing, and tints the row red when the source is
 * `cwd-fallback`. It does NOT poll, listen for WS events, or react
 * to runtime project-root changes — KB binds projectRoot at supervisor
 * startup (kovitoboard-master-spec §2.2 / process-lifecycle §1) and
 * the value cannot legally change without a restart.
 */
import { useEffect, useState } from 'react'
import { kbFetch } from '../lib/kbFetch'
import { t } from '../i18n'

type ProjectRootSource =
  | 'cli-arg'
  | 'env'
  | 'setting-json'
  | 'cwd-fallback'

interface ProjectRootResponse {
  projectRoot?: string
  source?: ProjectRootSource
}

function shortenHome(path: string): string {
  // Best-effort home-dir collapse: in a browser context we cannot
  // know `$HOME` directly, so we look at the path's leading segment.
  // POSIX-style only — KB targets WSL2 / macOS per
  // kovitoboard-master-spec §2.1.
  const m = path.match(/^\/(?:home|Users)\/[^/]+/)
  if (!m) return path
  return '~' + path.slice(m[0].length)
}

function sourceLabel(source: ProjectRootSource | undefined): string {
  // Use literal call sites so the t() compile-time MessageKey check
  // catches typos. Returning a synthesized key string would force us
  // to widen MessageKey to `string`, defeating the whole point of
  // the typed catalog.
  switch (source) {
    case 'cli-arg':
      return t('projectRootBanner.source.cliArg')
    case 'env':
      return t('projectRootBanner.source.env')
    case 'setting-json':
      return t('projectRootBanner.source.settingJson')
    case 'cwd-fallback':
      return t('projectRootBanner.source.cwdFallback')
    default:
      return t('projectRootBanner.source.unknown')
  }
}

export function ProjectRootBanner() {
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [source, setSource] = useState<ProjectRootSource | undefined>(undefined)

  useEffect(() => {
    let alive = true
    kbFetch('/api/config/project-root')
      .then((r) => r.json())
      .then((d: ProjectRootResponse) => {
        if (!alive) return
        setProjectRoot(d.projectRoot ?? null)
        setSource(d.source)
      })
      .catch(() => {
        if (!alive) return
        setProjectRoot(null)
      })
    return () => {
      alive = false
    }
  }, [])

  if (!projectRoot) return null

  const isWarning = source === 'cwd-fallback'
  const display = shortenHome(projectRoot)

  return (
    <div
      data-testid="project-root-banner"
      className={
        isWarning
          ? 'mt-auto border-t border-[var(--border)] bg-[var(--danger-bg, #2a1a1a)] text-[var(--text-primary)] px-2 py-2 text-[10px] flex flex-col gap-0.5 break-all'
          : 'mt-auto border-t border-[var(--border)] bg-[var(--bg-nav)] text-[var(--text-dim)] px-2 py-2 text-[10px] flex flex-col gap-0.5 break-all'
      }
      title={projectRoot}
    >
      <span className="font-medium uppercase opacity-60">
        {t('projectRootBanner.label')}
      </span>
      <span className="text-[var(--text-primary)]">{display}</span>
      <span className="opacity-70">{sourceLabel(source)}</span>
      {isWarning && (
        <span
          data-testid="project-root-banner-warning"
          className="text-[var(--accent-danger, #f87171)]"
        >
          {t('projectRootBanner.cwdFallbackWarning')}
        </span>
      )}
    </div>
  )
}
