/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Research Reports — page.tsx
 *
 * Main UI for Research Reports app.
 * - Theme input form with character counter
 * - In-progress job badges with 10s polling
 * - Completed/failed job list (newest first)
 * - Markdown report viewer in right pane
 *
 * Must use `export default` (required by React.lazy).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { MarkdownPreview } from '../../src/renderer/components/MarkdownPreview'

const POLL_INTERVAL_MS = 10_000
const MAX_THEME_LENGTH = 1000

/* ─── Types ─── */

interface JobSummary {
  jobId: string
  theme: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt?: string
}

interface JobStatus {
  jobId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt?: string
  error?: string
}

interface ReportData {
  jobId: string
  theme: string
  status: string
  report: string
  sources: Array<{ url: string; title: string; fetchedAt: string }>
}

/* ─── API helpers ─── */

async function startResearch(theme: string): Promise<{ jobId: string } | { error: string; maxConcurrent?: number }> {
  const res = await fetch('/api/ext/research-reports/start-research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  })
  return res.json()
}

async function fetchStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`/api/ext/research-reports/status?jobId=${encodeURIComponent(jobId)}`)
  return res.json()
}

async function fetchListReports(): Promise<{ reports: JobSummary[] }> {
  const res = await fetch('/api/ext/research-reports/list-reports')
  return res.json()
}

async function fetchReport(jobId: string): Promise<ReportData> {
  const res = await fetch(`/api/ext/research-reports/get-report?jobId=${encodeURIComponent(jobId)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/* ─── Component ─── */

export default function ResearchReportsPage() {
  const [theme, setTheme] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [reports, setReports] = useState<JobSummary[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [reportData, setReportData] = useState<ReportData | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /* ─── Load report list ─── */
  const refreshList = useCallback(async () => {
    try {
      const data = await fetchListReports()
      setReports(data.reports || [])
    } catch (err) {
      // Polling continues unconditionally — record the failure as warn
      // so chronic /list-reports breakage is visible in server.log.
      window.kb?.log.warn(
        { err, retryIntervalMs: POLL_INTERVAL_MS },
        'Failed to refresh job list during polling',
      )
    }
  }, [])

  /* ─── Polling: refresh list + poll active jobs ─── */
  useEffect(() => {
    refreshList()

    pollRef.current = setInterval(() => {
      refreshList()
    }, POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refreshList])

  /* ─── Stop polling when no active jobs ─── */
  const hasActiveJobs = reports.some((r) => r.status === 'queued' || r.status === 'running')
  useEffect(() => {
    if (!hasActiveJobs && pollRef.current) {
      // Keep polling but at lower frequency when no active jobs
      // (in case user starts a new one)
    }
  }, [hasActiveJobs])

  /* ─── Start research ─── */
  const handleStart = async () => {
    if (!theme.trim() || submitting) return
    setSubmitting(true)
    setError(null)

    try {
      const result = await startResearch(theme.trim())
      if ('error' in result) {
        switch (result.error) {
          case 'theme-required':
            setError('Please enter a research theme.')
            break
          case 'theme-too-long':
            setError(`Theme must be ${MAX_THEME_LENGTH} characters or less.`)
            break
          case 'queue-full':
            setError(`Concurrent job limit (${result.maxConcurrent}) reached. Please wait for a job to finish.`)
            break
          default:
            setError('An error occurred.')
        }
      } else {
        setTheme('')
        // Immediately refresh to show the new job
        await refreshList()
      }
    } catch (err) {
      window.kb?.log.error({ err }, 'Failed to start research')
      setError('Failed to communicate with the server.')
    } finally {
      setSubmitting(false)
    }
  }

  /* ─── Select report ─── */
  const handleSelectReport = async (jobId: string) => {
    setSelectedJobId(jobId)
    setReportData(null)
    setReportLoading(true)

    try {
      const data = await fetchReport(jobId)
      setReportData(data)
    } catch (err) {
      window.kb?.log.warn({ err, jobId }, 'Failed to load report')
      setReportData(null)
    } finally {
      setReportLoading(false)
    }
  }

  /* ─── Status badge ─── */
  const statusBadge = (status: string) => {
    switch (status) {
      case 'queued':
        return <span className="inline-block px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-300">Queued</span>
      case 'running':
        return <span className="inline-block px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-300">Researching...</span>
      case 'completed':
        return <span className="inline-block px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-300">Completed</span>
      case 'failed':
        return <span className="inline-block px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-300">Failed</span>
      default:
        return <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-500/20 text-gray-400">{status}</span>
    }
  }

  const activeJobs = reports.filter((r) => r.status === 'queued' || r.status === 'running')
  const finishedJobs = reports.filter((r) => r.status === 'completed' || r.status === 'failed')

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      {/* Left pane: form + list */}
      <div className="w-80 min-w-[280px] flex flex-col border-r border-[var(--border)] bg-[var(--bg-base)]">
        {/* Theme input form */}
        <div className="p-4 border-b border-[var(--border)]">
          <h1 className="text-base font-bold text-[var(--text-primary)] mb-3">
            Research Reports
          </h1>
          <div className="relative">
            <textarea
              data-testid="rr-theme-input"
              value={theme}
              onChange={(e) => setTheme(e.target.value.slice(0, MAX_THEME_LENGTH))}
              placeholder="Enter a research theme..."
              rows={3}
              className="w-full p-2 rounded border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-primary)] text-sm placeholder-[var(--text-dim)] resize-none focus:outline-none focus:border-[var(--accent-text)]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleStart()
                }
              }}
            />
            <div className="flex justify-between items-center mt-1">
              <span className="text-xs text-[var(--text-dim)]">
                {theme.length}/{MAX_THEME_LENGTH}
              </span>
              <button
                data-testid="rr-start-button"
                onClick={handleStart}
                disabled={!theme.trim() || submitting}
                className="px-3 py-1 rounded text-xs font-medium bg-[var(--accent-text)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              >
                {submitting ? 'Submitting...' : 'Start Research'}
              </button>
            </div>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <div className="p-3 border-b border-[var(--border)]">
            <h2 className="text-xs font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wider">
              In Progress
            </h2>
            <div className="space-y-1">
              {activeJobs.map((job) => (
                <div
                  key={job.jobId}
                  data-testid={`rr-job-status-${job.jobId}`}
                  className="flex items-center gap-2 p-2 rounded bg-[var(--bg-surface)] text-sm"
                >
                  {statusBadge(job.status)}
                  <span className="text-[var(--text-primary)] truncate flex-1 text-xs">
                    {job.theme}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Finished jobs list */}
        <div className="flex-1 overflow-y-auto p-3">
          <h2 className="text-xs font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wider">
            Reports
          </h2>
          {finishedJobs.length === 0 ? (
            <p className="text-xs text-[var(--text-dim)]">No reports yet</p>
          ) : (
            <div className="space-y-1">
              {finishedJobs.map((job) => (
                <button
                  key={job.jobId}
                  data-testid={`rr-list-item-${job.jobId}`}
                  onClick={() => job.status === 'completed' && handleSelectReport(job.jobId)}
                  className={`w-full text-left p-2 rounded text-sm transition-colors ${
                    selectedJobId === job.jobId
                      ? 'bg-[var(--accent-text)]/10 border border-[var(--accent-text)]/30'
                      : 'hover:bg-[var(--bg-surface)]'
                  } ${job.status === 'failed' ? 'opacity-60' : ''}`}
                  disabled={job.status === 'failed'}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {statusBadge(job.status)}
                    <span className="text-[10px] text-[var(--text-dim)]">
                      {new Date(job.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--text-primary)] line-clamp-2">
                    {job.theme}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right pane: report viewer */}
      <div className="flex-1 overflow-y-auto bg-[var(--bg-base)]">
        {reportLoading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-[var(--text-dim)]">Loading...</p>
          </div>
        ) : reportData ? (
          <div className="p-6 max-w-4xl mx-auto" data-testid="rr-report-body">
            <div className="mb-4">
              <h2 className="text-lg font-bold text-[var(--text-primary)]">
                {reportData.theme}
              </h2>
              <p className="text-xs text-[var(--text-dim)] mt-1">
                Job ID: {reportData.jobId}
              </p>
            </div>
            <div className="bg-[var(--bg-surface)] rounded-lg p-6 border border-[var(--border)]">
              <MarkdownPreview content={reportData.report} variant="document" />
            </div>
            {reportData.sources.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-2">
                  Sources ({reportData.sources.length})
                </h3>
                <ul className="space-y-1">
                  {reportData.sources.map((source, i) => (
                    <li key={i} className="text-xs">
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--accent-text)] hover:underline"
                      >
                        {source.title || source.url}
                      </a>
                      <span className="text-[var(--text-dim)] ml-2">
                        {new Date(source.fetchedAt).toLocaleString('en-US')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-sm text-[var(--text-dim)]">
                Select a report from the list on the left
              </p>
              <p className="text-xs text-[var(--text-dim)] mt-2">
                Or enter a theme to start a new research
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
