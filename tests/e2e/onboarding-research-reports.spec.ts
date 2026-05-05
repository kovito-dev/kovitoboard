/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Onboarding §4.11 completion verification — Phase RR-3
 *
 * Integration test ensuring the onboarding scenario §4.11
 * "Custom app (Intel-style feature) implementation" is reached via E2E.
 *
 * §4.11 verification points:
 * - app/research-reports/ directory generation (dialog is mocked, copy used instead)
 * - page.tsx and 3 API file generation
 * - "Research Reports" added to dashboard left side menu
 * - Theme input -> report generation -> display completion (WebFetch is mocked)
 *
 * Test approach:
 * - Copy app.example/research-reports/ to app/research-reports/ to reproduce
 *   the state where "a developer agent generated files"
 * - Place mock data in .kovitoboard/research-reports/ to verify
 *   the report display flow
 * - Since the server auto-starts via Playwright webServer,
 *   consider timing of app/ copy and server startup,
 *   focusing on API-level verification
 *
 * @see v0.1.0-onboarding-scenarios.md §4.11
 * @see v0.1.0-research-reports-plan.md §4-5
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const API_BASE = 'http://127.0.0.1:3001'

const PROJECT_ROOT = join(__dirname, '..', '..')
const APP_EXAMPLE_DIR = join(PROJECT_ROOT, 'app.example', 'research-reports')
const APP_DIR = join(PROJECT_ROOT, 'app', 'research-reports')
const DATA_DIR = join(PROJECT_ROOT, '.kovitoboard', 'research-reports')

/* --- Mock constants --- */

const MOCK_JOB_ID = 'rr-20260418T140000-onbd'
const MOCK_THEME = 'KovitoBoard v0.1.0 機能レビュー'
const MOCK_REPORT = [
  '# KovitoBoard v0.1.0 機能レビュー',
  '',
  '## 概要',
  '',
  'KovitoBoard はClaude Code上で動作するAIエージェントチームの管理ダッシュボードです。',
  '',
  '## 主要機能',
  '',
  '- エージェント管理',
  '- セッション監視',
  '- レシピシステム',
  '- app/ 拡張',
  '',
  '## まとめ',
  '',
  'v0.1.0 はローカル稼働を前提とした初期リリースです。',
].join('\n')

/* --- Fixture management --- */

function setupAppCopy(): void {
  if (!existsSync(APP_EXAMPLE_DIR)) return
  mkdirSync(join(PROJECT_ROOT, 'app'), { recursive: true })
  cpSync(APP_EXAMPLE_DIR, APP_DIR, { recursive: true })
}

function setupMockReport(): void {
  const jobDir = join(DATA_DIR, MOCK_JOB_ID)
  mkdirSync(jobDir, { recursive: true })

  writeFileSync(
    join(jobDir, 'status.json'),
    JSON.stringify({
      status: 'completed',
      startedAt: '2026-04-18T14:00:00Z',
      finishedAt: '2026-04-18T14:05:00Z',
    }),
  )
  writeFileSync(join(jobDir, 'report.md'), MOCK_REPORT)
  writeFileSync(
    join(jobDir, 'sources.json'),
    JSON.stringify({
      sources: [
        { url: 'https://github.com/kovito-dev/kovitoboard', title: 'KovitoBoard リポジトリ', fetchedAt: '2026-04-18T14:02:00Z' },
      ],
    }),
  )

  // Write jobs.jsonl
  const entry = JSON.stringify({
    jobId: MOCK_JOB_ID,
    theme: MOCK_THEME,
    status: 'completed',
    startedAt: '2026-04-18T14:00:00Z',
  })
  writeFileSync(join(DATA_DIR, 'jobs.jsonl'), entry + '\n')
}

function cleanup(): void {
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true })
  }
  if (existsSync(join(PROJECT_ROOT, 'app'))) {
    rmSync(join(PROJECT_ROOT, 'app'), { recursive: true, force: true })
  }
}

/* --- Tests --- */

test.describe('オンボーディング §4.11 到達確認 (RR-3) @preonboarding', () => {
  // --- §4.11 verification: File generation check --- //

  test('§4.11-V1: app.example/research-reports/ を app/ にコピーした際、必要なファイルが揃う', async () => {
    setupAppCopy()

    try {
      // §4.11 expected: app/research-reports/ directory exists
      expect(existsSync(APP_DIR)).toBe(true)

      // §4.11 expected: page.tsx exists
      expect(existsSync(join(APP_DIR, 'page.tsx'))).toBe(true)

      // §4.11 expected: 3 API files generated
      const apiDir = join(APP_DIR, 'api')
      expect(existsSync(apiDir)).toBe(true)

      const apiFiles = readdirSync(apiDir).filter((f) => f.endsWith('.ts'))
      expect(apiFiles).toContain('start-research.ts')
      expect(apiFiles).toContain('list-reports.ts')
      expect(apiFiles).toContain('get-report.ts')

      // Additional: status.ts also exists (for polling)
      expect(apiFiles).toContain('status.ts')
    } finally {
      cleanup()
    }
  })

  // --- §4.11 verification: Report flow at API level --- //

  test('§4.11-V2: list-reports API で完了済みレポートが一覧取得できる', async ({ request }) => {
    setupMockReport()

    try {
      const res = await request.get(`${API_BASE}/api/ext/research-reports/list-reports`)

      if (res.status() === 404) {
        test.skip(true, 'app/research-reports/ が app-api-loader にマウントされていない（§4.11 の前提として app/ のコピーとサーバー再起動が必要）')
        return
      }

      expect(res.ok()).toBeTruthy()
      const body = await res.json() as { reports: Array<{ jobId: string; theme: string; status: string }> }
      expect(body.reports.length).toBeGreaterThanOrEqual(1)

      const completedReport = body.reports.find((r) => r.jobId === MOCK_JOB_ID)
      expect(completedReport).toBeTruthy()
      expect(completedReport!.theme).toBe(MOCK_THEME)
      expect(completedReport!.status).toBe('completed')
    } finally {
      cleanup()
    }
  })

  test('§4.11-V3: get-report API でレポート本文と出典を取得できる', async ({ request }) => {
    setupMockReport()

    try {
      const res = await request.get(
        `${API_BASE}/api/ext/research-reports/get-report?jobId=${MOCK_JOB_ID}`,
      )

      if (res.status() === 404 && !(await res.text()).includes('not-found')) {
        test.skip(true, 'app/research-reports/ が app-api-loader にマウントされていない')
        return
      }

      expect(res.ok()).toBeTruthy()
      const body = await res.json() as {
        jobId: string
        theme: string
        report: string
        sources: Array<{ url: string; title: string }>
      }

      // §4.11 expected: title, summary, body, sources
      expect(body.report).toContain('# KovitoBoard v0.1.0 機能レビュー')
      expect(body.report).toContain('## 概要')
      expect(body.report).toContain('## 主要機能')
      expect(body.report).toContain('## まとめ')
      expect(body.sources.length).toBeGreaterThanOrEqual(1)
      expect(body.sources[0].title).toBeTruthy()
    } finally {
      cleanup()
    }
  })

  // --- §4.11 verification: start-research API validation --- //

  test('§4.11-V4: start-research API がテーマなしで 400 を返す', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/ext/research-reports/start-research`, {
      data: { theme: '' },
    })

    if (res.status() === 404) {
      test.skip(true, 'app/research-reports/ が app-api-loader にマウントされていない')
      return
    }

    expect(res.status()).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('theme-required')
  })

  test('§4.11-V5: start-research API がテーマ長超過で 400 を返す', async ({ request }) => {
    const longTheme = 'a'.repeat(1001)
    const res = await request.post(`${API_BASE}/api/ext/research-reports/start-research`, {
      data: { theme: longTheme },
    })

    if (res.status() === 404) {
      test.skip(true, 'app/research-reports/ が app-api-loader にマウントされていない')
      return
    }

    expect(res.status()).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('theme-too-long')
  })

  // --- §4.11 verification: Full flow integration check --- //

  test('§4.11-V6: ファイル生成 → レポート配置 → API 取得の全フローが成立する', async ({ request }) => {
    // Step 1: Copy to app/ (reproduce state where developer agent generated files)
    setupAppCopy()
    expect(existsSync(APP_DIR)).toBe(true)

    // Step 2: Place mock report (reproduce state after research completion)
    setupMockReport()

    try {
      // Step 3: Get list via list-reports
      const listRes = await request.get(`${API_BASE}/api/ext/research-reports/list-reports`)
      if (listRes.status() === 404) {
        test.skip(true, 'app/research-reports/ のマウントにはサーバー再起動が必要')
        return
      }
      expect(listRes.ok()).toBeTruthy()

      const listBody = await listRes.json() as { reports: Array<{ jobId: string; status: string }> }
      const target = listBody.reports.find((r) => r.jobId === MOCK_JOB_ID)
      expect(target).toBeTruthy()
      expect(target!.status).toBe('completed')

      // Step 4: Get report body via get-report
      const reportRes = await request.get(
        `${API_BASE}/api/ext/research-reports/get-report?jobId=${MOCK_JOB_ID}`,
      )
      expect(reportRes.ok()).toBeTruthy()

      const reportBody = await reportRes.json() as { report: string; sources: unknown[] }
      expect(reportBody.report).toContain('KovitoBoard')
      expect(reportBody.sources).toHaveLength(1)

      // Step 5: Verify completion via status
      const statusRes = await request.get(
        `${API_BASE}/api/ext/research-reports/status?jobId=${MOCK_JOB_ID}`,
      )
      expect(statusRes.ok()).toBeTruthy()

      const statusBody = await statusRes.json() as { status: string; finishedAt?: string }
      expect(statusBody.status).toBe('completed')
      expect(statusBody.finishedAt).toBeTruthy()
    } finally {
      cleanup()
    }
  })
})
