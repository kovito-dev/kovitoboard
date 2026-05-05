/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Project Fixture Helper — Dynamic fixture creation for individual tests
 *
 * Use this when a test needs a fresh project fixture beyond what
 * globalSetup provides (e.g., S11 export/import with a clean directory).
 *
 * @see docs/design/e2e-l1-harness-extension.md §7-3
 */
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const FIXTURES_ROOT = resolve(__dirname, '../../fixtures/projects')

export type FixtureTemplate = 'blank' | 'blank-onboarded' | 'existing-rich'

export interface ProjectFixture {
  /** Absolute path to the project root in the temp directory */
  projectRoot: string
  /** Clean up the temporary fixture directory */
  dispose(): Promise<void>
}

/**
 * Create a temporary project fixture from a template.
 * The caller is responsible for calling dispose() when done.
 */
export async function createProjectFixture(
  template: FixtureTemplate,
): Promise<ProjectFixture> {
  const tmpDir = await mkdtemp(join(tmpdir(), `kb-e2e-fixture-`))
  const projectRoot = join(tmpDir, template)
  await cp(join(FIXTURES_ROOT, template), projectRoot, { recursive: true })

  // Patch setting.json with actual path
  const settingPath = join(projectRoot, '.kovitoboard', 'setting.json')
  try {
    const raw = await readFile(settingPath, 'utf-8')
    const data = JSON.parse(raw)
    if (data.project) data.project.path = projectRoot
    await writeFile(settingPath, JSON.stringify(data, null, 2))
  } catch {
    // blank template has no setting.json
  }

  return {
    projectRoot,
    async dispose() {
      await rm(tmpDir, { recursive: true, force: true })
    },
  }
}
