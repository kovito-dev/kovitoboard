/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Phase 2-A regression test for `installAgentRefDocs` wiring.
 *
 * Spec SSOT: `process-lifecycle.md` v1.3 §13.1 Phase 2-A row, in the
 * kovitoboard-dev workspace. Before Phase 2-A, the `PUT
 * /api/config/setting` route handler called
 * `installAgentRefDocs(fs, body.project.path, body.locale)` —
 * trusting an attacker-controllable string from the request body.
 * `validateSetting` only checks type and non-emptiness, not
 * location, so a crafted PUT could redirect the agent-ref tree (and
 * the bundled .md docs it carries) outside the project root.
 *
 * Phase 2-A anchors the call on the *server-trusted* `projectRoot`
 * argument that the supervisor resolves once at startup, mirroring
 * the CLAUDE.md guidance injection pattern (PR #19, D-trusted-root).
 *
 * The regression guard here boots the real Express router against a
 * pair of tempdirs — a trusted `projectRoot` and a separate
 * "attacker" path — and asserts that the agent-ref docs land under
 * the trusted root regardless of what the client sends.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _resetProjectRootCache } from '../../src/server/config'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { initLogger } from '../../src/server/logger'
import { createConfigRouter } from '../../src/server/routes/config-routes'
import type { KovitoboardSetting } from '../../src/shared/setting-types'

const fs = new DirectFsLayer()
let loggerRoot: string

let trustedRoot: string
let attackerRoot: string
let server: Server
let baseUrl: string

function makeSetting(overrides: Partial<KovitoboardSetting> = {}): KovitoboardSetting {
  return {
    version: '1.2',
    revision: 1,
    additionalWorkRoots: [],
    workRootsMetadata: {},
    user: { displayName: 'Test', avatar: null },
    project: {
      name: 'trusted-test',
      description: '',
      // Deliberately wrong: simulates a hostile client sending a path
      // outside the trusted projectRoot. The route handler must
      // ignore this value when wiring `installAgentRefDocs`.
      path: attackerRoot,
    },
    locale: 'en',
    onboarding: { completedAt: '2026-05-10T00:00:00.000Z', wizardVersion: '0.1.0' },
    // Disable the CLAUDE.md guidance side-effect so the test stays
    // focused on the agent-ref installer wiring. The injection helper
    // already has its own coverage in `claude-md-guidance.test.ts`.
    claudeMdGuidance: { disabled: true },
    ...overrides,
  }
}

// The express app is built once and re-binds the router on every
// request so each test can swap its per-test `trustedRoot` without
// restarting the server.
const app = express()
app.use(express.json())
app.use('/api/config', (req, _res, next) => {
  const router = createConfigRouter(fs, trustedRoot)
  router(req, _res, next)
})

beforeAll(async () => {
  // The route handler calls into `serverLogger`, which is a lazy
  // proxy backed by the root pino logger. Without a one-shot init
  // any call surfaces as `Root logger not initialized` and the
  // route returns 500. We initialize against a dedicated tempdir
  // so the per-test trusted roots stay free of stray log files.
  loggerRoot = mkdtempSync(join(tmpdir(), 'kb-trusted-test-logger-'))
  mkdirSync(join(loggerRoot, '.kovitoboard', 'logs'), { recursive: true })
  await initLogger(loggerRoot, null)

  await new Promise<void>((resolveStart) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolveStart()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  rmSync(loggerRoot, { recursive: true, force: true })
})

beforeEach(() => {
  trustedRoot = mkdtempSync(join(tmpdir(), 'kb-trusted-root-'))
  attackerRoot = mkdtempSync(join(tmpdir(), 'kb-attacker-root-'))
  // The setting-manager (used internally by the PUT handler) resolves
  // its `.kovitoboard/` directory through `resolveProjectRoot`, which
  // is module-level cached. Pin the env var to the same trusted root
  // we wire into `createConfigRouter` so `writeSetting` writes under
  // the trusted tempdir, and reset the cache so each test sees its
  // own value.
  process.env.KOVITOBOARD_PROJECT_ROOT = trustedRoot
  _resetProjectRootCache()
})

afterEach(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
  _resetProjectRootCache()
  rmSync(trustedRoot, { recursive: true, force: true })
  rmSync(attackerRoot, { recursive: true, force: true })
})

describe('PUT /api/config/setting — trusted projectRoot wiring (Phase 2-A)', () => {
  it('installs agent-ref docs under the trusted projectRoot, not body.project.path', async () => {
    const res = await fetch(`${baseUrl}/api/config/setting`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSetting()),
    })
    expect(res.status).toBe(200)

    // The agent-ref bundle lands under the trusted root.
    const trustedRefDir = join(trustedRoot, '.kovitoboard', 'agent-ref')
    expect(existsSync(trustedRefDir)).toBe(true)
    // English locale → top-level .md files copied from
    // <kbRoot>/docs/agent-ref/en/.
    expect(existsSync(join(trustedRefDir, '01-overview.md'))).toBe(true)

    // The attacker-controlled path receives nothing.
    const attackerRefDir = join(attackerRoot, '.kovitoboard', 'agent-ref')
    expect(existsSync(attackerRefDir)).toBe(false)
  })

  it('preserves the existing copy on a re-PUT (skip-if-exists semantics, unchanged)', async () => {
    // First PUT creates the agent-ref tree.
    let res = await fetch(`${baseUrl}/api/config/setting`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSetting()),
    })
    expect(res.status).toBe(200)
    const trustedRefDir = join(trustedRoot, '.kovitoboard', 'agent-ref')
    expect(existsSync(trustedRefDir)).toBe(true)

    // Plant a marker file so we can detect whether the installer
    // overwrote the existing tree (it must NOT — `installed: false`
    // when destDir already exists, see `agent-ref-installer.ts`).
    writeFileSync(join(trustedRefDir, 'marker.txt'), 'preserved')

    // Second PUT — agent-ref should remain untouched.
    res = await fetch(`${baseUrl}/api/config/setting`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSetting()),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(trustedRefDir, 'marker.txt'))).toBe(true)
  })

  it('does not write to body.project.path even when it points at a writable directory', async () => {
    // Pre-populate the attacker root with a marker so we can prove
    // it was not touched by the installer.
    mkdirSync(attackerRoot, { recursive: true })
    writeFileSync(join(attackerRoot, 'attacker-marker.txt'), 'present')

    const res = await fetch(`${baseUrl}/api/config/setting`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSetting()),
    })
    expect(res.status).toBe(200)

    // Marker still there, no agent-ref directory created under the
    // attacker root.
    expect(existsSync(join(attackerRoot, 'attacker-marker.txt'))).toBe(true)
    expect(existsSync(join(attackerRoot, '.kovitoboard'))).toBe(false)
  })

  it('overwrites a client-supplied project.path with the trusted projectRoot before persisting', async () => {
    // Defense-in-depth: the route normalizes `body.project.path =
    // projectRoot` before `writeSetting` so that even later code
    // that reads `setting.project.path` from disk (notably
    // `config.ts` `resolveProjectRootWithSource` priority-3) cannot
    // observe the attacker's value. Legitimate clients send the
    // same trusted root they read from `GET /api/config/project-
    // root`, so this normalization is a no-op for them.
    const res = await fetch(`${baseUrl}/api/config/setting`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSetting()),
    })
    expect(res.status).toBe(200)

    const settingPath = join(trustedRoot, '.kovitoboard', 'setting.json')
    expect(existsSync(settingPath)).toBe(true)
    const persisted = JSON.parse(readFileSync(settingPath, 'utf-8'))
    // The body claimed `project.path = attackerRoot`. After the
    // route handler ran, the persisted value must be `trustedRoot`.
    expect(persisted.project.path).toBe(trustedRoot)
    expect(persisted.project.path).not.toBe(attackerRoot)
  })
})
