/**
 * Fake Claude Harness — tmux mock management for Playwright E2E tests
 *
 * Launches Fake Claude scripts inside tmux sessions so that
 * KB's trust-prompt-detector can capture and detect prompts just like in production.
 *
 * @see docs/design/fake-claude-design.md
 * @see docs/design/decisions/DEC-010-fake-claude-e2e-strategy.md
 */

import { execSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Directory containing the Fake Claude scripts */
const FAKE_CLAUDE_DIR = resolve(__dirname, '../../fixtures/fake-claude')

export type FakeClaudeScenario =
  | 'folder-trust'
  | 'write-create'
  | 'edit-modify'
  | 'bash-simple'
  | 'rejection-flow'

export interface FakeClaudeHandle {
  /** tmux session name (unique) */
  sessionName: string
  /** tmux window name */
  windowName: string
  /** Destroy the session */
  dispose(): Promise<void>
  /** Send additional keys (for follow-up operations after a response) */
  sendKeys(keys: string): Promise<void>
  /** Capture the current pane content (for debugging and assertions) */
  capture(): Promise<string>
}

export interface StartFakeClaudeOptions {
  /** Scenario name (filename from scenarios/*.sh without the .sh extension) */
  scenario: FakeClaudeScenario
  /** tmux window name (KB treats the window name as the agent ID) */
  windowName: string
  /** Explicit tmux session name (default: auto-resolved E2E shared session name) */
  sessionName?: string
}

/**
 * Resolve the shared E2E tmux session name.
 *
 * Uses the KOVITOBOARD_E2E_TMUX_SESSION env var if set,
 * otherwise generates a unique test-specific name.
 */
function resolveSessionName(override?: string): string {
  if (override) return override
  return process.env.KOVITOBOARD_E2E_TMUX_SESSION || `kb-e2e-${randomUUID().slice(0, 8)}`
}

/**
 * Start Fake Claude inside a tmux session.
 *
 * Creates a window inside the session specified by KOVITOBOARD_E2E_TMUX_SESSION,
 * which KB's tmux-bridge will reference.
 */
export async function startFakeClaude(
  opts: StartFakeClaudeOptions,
): Promise<FakeClaudeHandle> {
  const sessionName = resolveSessionName(opts.sessionName)
  const scriptPath = resolve(FAKE_CLAUDE_DIR, 'entrypoint.sh')

  // Create the session if it does not exist
  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: 'pipe',
  })

  if (hasSession.status !== 0) {
    // Create a new session with fixed dimensions (pitfall #2 mitigation)
    execSync(
      `tmux new-session -d -s "${sessionName}" -n main -x 200 -y 50`,
      { stdio: 'pipe' },
    )
  }

  // Remove existing window with the same name (idempotency)
  spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${opts.windowName}`], {
    stdio: 'pipe',
  })

  // Create a window that runs the Fake Claude script
  execSync(
    `tmux new-window -t "${sessionName}" -n "${opts.windowName}" ` +
    `"bash '${scriptPath}' '${opts.scenario}'"`,
    { stdio: 'pipe' },
  )

  // Wait briefly for the fixture to finish rendering
  await new Promise((r) => setTimeout(r, 500))

  return {
    sessionName,
    windowName: opts.windowName,

    async dispose() {
      spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${opts.windowName}`], {
        stdio: 'pipe',
      })
      // Destroy the session if no windows remain
      const remaining = spawnSync('tmux', [
        'list-windows', '-t', sessionName,
      ], { stdio: 'pipe' })
      const output = remaining.stdout?.toString().trim() ?? ''
      // If only the main window remains (or empty), destroy the session
      const lines = output.split('\n').filter((l) => l.trim())
      if (lines.length <= 1) {
        spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' })
      }
    },

    async sendKeys(keys: string) {
      spawnSync('tmux', [
        'send-keys', '-t', `${sessionName}:${opts.windowName}`, keys,
      ], { stdio: 'pipe' })
    },

    async capture() {
      const r = spawnSync('tmux', [
        'capture-pane', '-pt', `${sessionName}:${opts.windowName}`, '-S', '-200',
      ], { stdio: 'pipe' })
      return r.stdout?.toString() ?? ''
    },
  }
}

/**
 * Fully clean up the tmux session used for E2E tests.
 * Call this in test.afterAll.
 */
export async function cleanupFakeClaudeSession(sessionName: string): Promise<void> {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' })
}
