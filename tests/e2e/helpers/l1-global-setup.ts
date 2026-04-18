/**
 * L1 Global Setup — Prepare project fixtures for Playwright projects
 *
 * Expands project fixture templates into a temporary directory and
 * exports environment variables for each Playwright project's webServer.
 *
 * @see docs/design/e2e-l1-harness-extension.md §6-2
 */
import { cp, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const FIXTURES_ROOT = resolve(__dirname, '../../fixtures/projects')

type Template = 'blank' | 'blank-onboarded' | 'existing-rich'

/**
 * Copy a project fixture template to a temporary directory
 * and patch setting.json with the actual path.
 */
async function prepareProjectFixture(
  rootDir: string,
  name: string,
  template: Template,
): Promise<string> {
  const dest = join(rootDir, name)
  await cp(join(FIXTURES_ROOT, template), dest, { recursive: true })

  // Overwrite project.path in setting.json with the actual temp path
  const settingPath = join(dest, '.kovitoboard', 'setting.json')
  try {
    const raw = await readFile(settingPath, 'utf-8')
    const data = JSON.parse(raw)
    if (data.project) data.project.path = dest
    await writeFile(settingPath, JSON.stringify(data, null, 2))
  } catch {
    // blank template has no setting.json — skip silently
  }

  return dest
}

export default async function globalSetup(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'kb-e2e-'))
  process.env.KB_E2E_ROOT = rootDir

  process.env.KB_E2E_PROJECT_ROOT_DEFAULT =
    await prepareProjectFixture(rootDir, 'default', 'blank-onboarded')

  process.env.KB_E2E_PROJECT_ROOT_PREONBOARDING =
    await prepareProjectFixture(rootDir, 'preonboarding', 'blank')

  process.env.KB_E2E_PROJECT_ROOT_RICH =
    await prepareProjectFixture(rootDir, 'rich', 'existing-rich')

  console.log(`[l1-global-setup] Fixtures expanded to: ${rootDir}`)
}
