/**
 * Recipe security inspector — Layer 0 + Layer 1a + Layer 1b (stub).
 */
import { normalize, extname } from 'path'
import type {
  ParsedRecipe,
  Finding,
  FindingSeverity,
  InspectionResult,
  InspectionVerdict,
} from '../shared/recipe-types'

const ALLOWED_EXTENSIONS = new Set(['.tsx', '.ts', '.css', '.json', '.md'])
const ALLOWED_PATH_PREFIXES = ['pages/', 'styles/', 'lib/', 'hooks/', 'utils/']
const MAX_FILE_SIZE = 100 * 1024  // 100 KB
const MAX_TOTAL_SIZE = 500 * 1024 // 500 KB

// --- Layer 0: Capability restrictions (programmatic enforcement) ---

function validateLayer0(recipe: ParsedRecipe): Finding[] {
  const findings: Finding[] = []

  let totalSize = 0
  for (const artifact of recipe.artifacts) {
    // File extension whitelist
    const ext = extname(artifact.path)
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      findings.push({
        severity: 'critical',
        file: artifact.path,
        description: `Forbidden file extension: ${ext} (allowed: ${[...ALLOWED_EXTENSIONS].join(', ')})`,
      })
    }

    // api type forbidden in v0.1.0
    if ((artifact.type as string) === 'api') {
      findings.push({
        severity: 'critical',
        file: artifact.path,
        description: 'Backend API artifacts are not allowed in v0.1.0',
      })
    }

    // Path validation
    const normalized = normalize(artifact.path)
    if (normalized.startsWith('..') || normalized.startsWith('/')) {
      findings.push({
        severity: 'critical',
        file: artifact.path,
        description: `Path traversal detected: ${artifact.path}`,
      })
    } else if (!ALLOWED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      findings.push({
        severity: 'critical',
        file: artifact.path,
        description: `Path not allowed: ${artifact.path} (must start with ${ALLOWED_PATH_PREFIXES.join(', ')})`,
      })
    }

    // Size limits
    if (artifact.sizeBytes > MAX_FILE_SIZE) {
      findings.push({
        severity: 'critical',
        file: artifact.path,
        description: `File too large: ${(artifact.sizeBytes / 1024).toFixed(1)} KB (max ${MAX_FILE_SIZE / 1024} KB)`,
      })
    }
    totalSize += artifact.sizeBytes
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    findings.push({
      severity: 'critical',
      file: 'recipe',
      description: `Total size too large: ${(totalSize / 1024).toFixed(1)} KB (max ${MAX_TOTAL_SIZE / 1024} KB)`,
    })
  }

  return findings
}

// --- Layer 1a: Local static analysis ---

interface DangerPattern {
  pattern: RegExp
  severity: FindingSeverity
  description: string
}

const CODE_DANGER_PATTERNS: DangerPattern[] = [
  // Data exfiltration
  { pattern: /fetch\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/gm, severity: 'high', description: 'fetch() with external URL — potential data exfiltration' },
  { pattern: /new\s+WebSocket\s*\(\s*['"`]wss?:\/\/(?!localhost|127\.0\.0\.1)/gm, severity: 'high', description: 'WebSocket to external host — potential data exfiltration' },
  { pattern: /navigator\.sendBeacon\s*\(/gm, severity: 'high', description: 'navigator.sendBeacon() — potential silent data exfiltration' },
  { pattern: /new\s+Image\s*\(\s*\)\s*\.src\s*=/gm, severity: 'medium', description: 'Image beacon pattern — potential data exfiltration' },

  // Code injection
  { pattern: /\beval\s*\(/gm, severity: 'critical', description: 'eval() — code injection risk' },
  { pattern: /new\s+Function\s*\(/gm, severity: 'critical', description: 'new Function() — code injection risk' },

  // Cookie / storage theft
  { pattern: /document\.cookie/gm, severity: 'critical', description: 'document.cookie access — cookie theft risk' },
  { pattern: /localStorage\b/gm, severity: 'medium', description: 'localStorage access' },
  { pattern: /sessionStorage\b/gm, severity: 'medium', description: 'sessionStorage access' },

  // XSS
  { pattern: /\.innerHTML\s*=/gm, severity: 'medium', description: 'innerHTML assignment — XSS risk' },
  { pattern: /dangerouslySetInnerHTML/gm, severity: 'medium', description: 'dangerouslySetInnerHTML — XSS risk' },

  // Phishing / navigation
  { pattern: /window\.open\s*\(/gm, severity: 'medium', description: 'window.open() — potential phishing' },

  // Obfuscation
  { pattern: /atob\s*\(\s*['"`][A-Za-z0-9+/=]{50,}/gm, severity: 'high', description: 'atob() with long Base64 — potential obfuscated payload' },
  { pattern: /String\.fromCharCode\s*\([\s\S]{30,}\)/gm, severity: 'high', description: 'String.fromCharCode chain — potential obfuscated code' },
]

const INSTRUCTION_DANGER_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Constraint override
  { pattern: /上記の(制約|ルール|指示)を(無視|変更|取り消|忘れ)/g, description: 'Constraint override attempt (JP)' },
  { pattern: /ignore (the )?(above|previous) (constraints|rules|instructions)/gi, description: 'Constraint override attempt' },
  { pattern: /disregard (the )?(above|previous|all)/gi, description: 'Disregard instruction attempt' },
  { pattern: /you are now/gi, description: 'Role override attempt' },
  { pattern: /act as/gi, description: 'Role override attempt' },
  { pattern: /pretend (that|to)/gi, description: 'Role override attempt' },

  // Sandbox bypass
  { pattern: /bypass(ing)? (the )?(security|safety|sandbox)/gi, description: 'Sandbox bypass attempt' },
  { pattern: /disable (the )?(security|safety|sandbox|restrictions)/gi, description: 'Security disable attempt' },

  // File system outside app/
  { pattern: /CLAUDE\.md/g, description: 'Reference to CLAUDE.md' },
  { pattern: /\.claude\//g, description: 'Reference to .claude/' },
  { pattern: /\bsrc\//g, description: 'Reference to src/' },
  { pattern: /package\.json/g, description: 'Reference to package.json' },

  // Package installation
  { pattern: /npm (install|i)\b/gi, description: 'npm install command' },
  { pattern: /yarn add\b/gi, description: 'yarn add command' },
  { pattern: /pnpm (add|install)\b/gi, description: 'pnpm install command' },
  { pattern: /\bnpx\b/gi, description: 'npx command' },

  // System operations
  { pattern: /\bsudo\b/g, description: 'sudo command' },
  { pattern: /\bcurl\b/g, description: 'curl command' },
  { pattern: /\bwget\b/g, description: 'wget command' },
  { pattern: /\bssh\b/g, description: 'ssh command' },

  // Credential access
  { pattern: /\bkeychain\b/gi, description: 'Keychain access' },
  { pattern: /\bcredential\b/gi, description: 'Credential access' },
  { pattern: /\.env\b/g, description: '.env file reference' },
]

function analyzeLayer1a(recipe: ParsedRecipe): Finding[] {
  const findings: Finding[] = []

  // Scan artifact code
  for (const artifact of recipe.artifacts) {
    // Only scan code files
    const ext = extname(artifact.path)
    if (ext === '.json' || ext === '.md') continue

    const lines = artifact.content.split('\n')
    for (const pattern of CODE_DANGER_PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.pattern.exec(artifact.content)) !== null) {
        const lineNum = artifact.content.slice(0, match.index).split('\n').length
        findings.push({
          severity: pattern.severity,
          file: artifact.path,
          line: lineNum,
          description: pattern.description,
          context: lines[lineNum - 1]?.trim(),
        })
      }
    }
  }

  // Scan instruction for prompt injection
  if (recipe.instruction) {
    for (const pattern of INSTRUCTION_DANGER_PATTERNS) {
      pattern.pattern.lastIndex = 0
      if (pattern.pattern.test(recipe.instruction)) {
        findings.push({
          severity: 'high',
          file: 'instruction',
          description: `Prompt injection detected: ${pattern.description}`,
        })
      }
    }
  }

  // Scan metadata fields for injection
  const metaFields = [recipe.metadata.name, recipe.metadata.description]
  for (const field of metaFields) {
    for (const pattern of INSTRUCTION_DANGER_PATTERNS) {
      pattern.pattern.lastIndex = 0
      if (pattern.pattern.test(field)) {
        findings.push({
          severity: 'high',
          file: 'metadata',
          description: `Prompt injection in metadata: ${pattern.description}`,
        })
      }
    }
  }

  return findings
}

// --- Layer 1b: External inspection API (v0.1.0 stub) ---

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callInspectApi(_recipe: ParsedRecipe): Promise<{ skipped: true }> {
  // v0.1.0: always returns skipped. External API will be added in v0.2.0.
  return { skipped: true }
}

// --- Verdict computation ---

function computeVerdict(findings: Finding[]): InspectionVerdict {
  if (findings.some((f) => f.severity === 'critical')) return 'blocked'
  if (findings.some((f) => f.severity === 'high')) return 'warning'
  if (findings.some((f) => f.severity === 'medium')) return 'caution'
  return 'safe'
}

// --- Public API ---

/**
 * Run full security inspection on a parsed recipe.
 */
export async function inspectRecipe(recipe: ParsedRecipe): Promise<InspectionResult> {
  const layer0 = validateLayer0(recipe)
  const layer1a = analyzeLayer1a(recipe)
  const remoteResult = await callInspectApi(recipe)

  const allFindings = [...layer0, ...layer1a]
  const verdict = computeVerdict(allFindings)

  return {
    verdict,
    findings: allFindings,
    remoteCheckSkipped: remoteResult.skipped,
    note: remoteResult.skipped
      ? 'External safety check unavailable. Showing local check results only.'
      : undefined,
  }
}

/**
 * Sanitize instruction text by removing dangerous patterns.
 * Returns the sanitized text and a list of removed pattern descriptions.
 */
export function sanitizeInstruction(instruction: string): {
  sanitized: string
  removedPatterns: string[]
} {
  let sanitized = instruction
  const removedPatterns: string[] = []

  for (const { pattern, description } of INSTRUCTION_DANGER_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(sanitized)) {
      removedPatterns.push(description)
      pattern.lastIndex = 0
      sanitized = sanitized.replace(pattern, '[REMOVED]')
    }
  }

  return { sanitized, removedPatterns }
}
