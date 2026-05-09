/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Centralized logger for KovitoBoard (DEC-017).
 *
 * Provides a pino instance configured with:
 *
 * - Multistream: stdout + rotating file (`.kovitoboard/logs/server.log`)
 *   in identical JSON Lines format
 * - Home-directory path masking applied at write time
 * - ISO 8601 timestamps and pid in every record
 * - Daily rotation with configurable retention (default 7 days)
 *
 * The logger is initialized lazily via `initLogger(projectRoot)` so the
 * project root resolution and `.kovitoboard/` directory creation happen
 * before pino opens the log file. After initialization, child loggers
 * keyed by component name are exposed via `childLogger(name)` and a few
 * convenience exports (serverLogger, tmuxLogger, etc.).
 *
 * Design rationale: see `docs/design/v0.1.0-logging-design.md` and
 * `docs/design/decisions/DEC-017-logging-baseline.md`.
 */
import { join } from 'path'
import { homedir } from 'os'
import pino, { type Logger, type StreamEntry } from 'pino'
import pinoRoll from 'pino-roll'
import type { Writable } from 'stream'
import { resolveLogConfig, type LogConfig } from './log-config'
import type { KovitoboardSetting } from '../shared/setting-types'

const COMPONENT_FALLBACK = 'unknown'

let rootLogger: Logger | null = null
let fileStreamHandle: Writable | null = null
let initialized = false

/** Escape a string for safe inclusion in a RegExp pattern. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mask the home directory path in any string. Exported for the diagnose
 * CLI and unit tests.
 */
export function maskHomePath(input: string): string {
  const home = homedir()
  if (!home || home.length < 2) return input
  return input.replace(new RegExp(escapeRegExp(home), 'g'), '~')
}

/**
 * Patterns matched and redacted from log strings to keep
 * authorization material out of `.kovitoboard/logs/server.log` and
 * stdout. The applied list intentionally stays narrow: each pattern
 * targets a value shape that is never a legitimate component name,
 * file path, or human-readable message, so false positives stay rare
 * and the redaction does not eat structured fields agents need to
 * read.
 *
 * Coverage:
 * - Anthropic API keys (`sk-ant-…`) the Claude CLI may print on stderr.
 * - Generic JWTs (`<base64url>.<base64url>.<base64url>`), which is the
 *   shape of every OAuth bearer / session token that could end up in a
 *   `paneTail` capture or a CLI failure message.
 *
 * Each match is replaced with a length-preserving `<sk-ant redacted>`
 * / `<jwt redacted>` placeholder so log readers can still tell *that*
 * a credential appeared without exposing its value.
 *
 * Adding new patterns: prefer narrow shapes (a unique prefix or
 * exact length range). Broad heuristics (e.g. "any 40-char hex
 * string") will mask hashes / sha256 commit ids that handlers and
 * tests legitimately log.
 */
const SENSITIVE_TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; placeholder: string }> = [
  // Anthropic API key prefix; emitted in plaintext by `claude` CLI on
  // some auth-failure paths and surfaces through claude-bridge stderr.
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, placeholder: '<sk-ant redacted>' },
  // Generic JWT (OAuth bearer / session). 3 base64url segments
  // separated by dots, with the `eyJ` (`{"…`) header prefix on the
  // first two segments. 4+ chars per segment so compact JWTs whose
  // payload is small (e.g. `{"exp":1}` → `eyJleHAiOjF9`) are still
  // matched while `a.b.c`-shape false positives are still excluded
  // by the `eyJ` prefix gate.
  { pattern: /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, placeholder: '<jwt redacted>' },
]

/**
 * Apply every credential-pattern redaction to a single string.
 * Exported for the diagnose CLI and unit tests so the redaction can
 * be verified the same way `maskHomePath` is.
 */
export function redactSensitiveTokens(input: string): string {
  let out = input
  for (const { pattern, placeholder } of SENSITIVE_TOKEN_PATTERNS) {
    out = out.replace(pattern, placeholder)
  }
  return out
}

/**
 * Single-pass walker that applies every active redaction (home-path
 * mask + credential token redaction) to every string-typed value
 * inside a log record. Visiting the record once and applying both
 * substitutions per-string avoids the double-walk + double-clone
 * cost of composing two independent visitors, which matters on
 * hot paths that log large arrays such as the trust-prompt
 * fallback `paneTail` (50 raw capture lines per fire).
 *
 * Applied via pino's `formatters.log` so the redaction happens at
 * write-time only — in-memory objects passed to logger.* are not
 * mutated, and behavior of the rest of the program is unaffected.
 */
function buildLogRedactor(): (obj: Record<string, unknown>) => Record<string, unknown> {
  const home = homedir()
  // Honour the safety check used by maskHomePath: no usable home
  // directory means we skip the home-path layer (CI env with
  // `HOME=/`).
  const homeUsable = !!home && home.length >= 2
  const homePattern = homeUsable ? new RegExp(escapeRegExp(home), 'g') : null

  const replaceString = (s: string): string => {
    let out = s
    if (homePattern) out = out.replace(homePattern, '~')
    out = redactSensitiveTokens(out)
    return out
  }

  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceString(value)
    if (value === null || value === undefined) return value
    if (Array.isArray(value)) return value.map(visit)
    if (typeof value === 'object') {
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        next[k] = visit(v)
      }
      return next
    }
    return value
  }

  return (obj) => visit(obj) as Record<string, unknown>
}

/**
 * Initialize the root logger. Must be called once during server
 * startup, before any childLogger() / serverLogger() / etc. is used.
 *
 * Idempotent: subsequent calls are no-ops and return the existing
 * logger.
 */
export async function initLogger(
  projectRoot: string,
  setting: KovitoboardSetting | null,
): Promise<Logger> {
  if (initialized && rootLogger) return rootLogger

  const config: LogConfig = resolveLogConfig(setting)
  const logFilePath = join(projectRoot, '.kovitoboard', 'logs', 'server.log')

  // Build the rolling file stream. pino-roll opens the file lazily
  // and handles daily rotation. Retention is approximated via a
  // file-count cap (pino-roll v4 doesn't expose a per-day age cap).
  // The cap is `retentionDays + 1` so the current day's active file
  // never trips the limit mid-day if rotation jitters slightly.
  const fileStream = await pinoRoll({
    file: logFilePath,
    frequency: 'daily',
    size: '500m',
    dateFormat: 'yyyy-MM-dd',
    extension: '.log',
    symlink: true,
    limit: { count: config.retentionDays + 1 },
  })
  fileStreamHandle = fileStream

  const streams: StreamEntry[] = [
    { stream: process.stdout, level: config.level },
    { stream: fileStream, level: config.level },
  ]

  const maskLog = buildLogRedactor()

  rootLogger = pino(
    {
      level: config.level,
      base: { pid: process.pid },
      // Emit `"ts":"<ISO 8601 UTC>"` (DEC-017 §3.1 schema). The default
      // pino field name is `time`; the schema mandates `ts`. We embed
      // the field name directly because pino's `timestamp` option is
      // serialized into the output line as-is.
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
        log: maskLog,
      },
      hooks: {
        // pino's `formatters.log` only sees the merging object, not
        // the trailing positional arguments. Without this hook,
        // `logger.info('text with sk-ant-... inline')` persists the
        // token verbatim, and printf-style interpolation such as
        // `logger.info('failed %o', { apiKey: '…' })` also leaks
        // through pino's internal `util.format` step. Intercept
        // every level method, redact each string positional arg in
        // place, and walk every object/array/Error positional arg
        // through the same record redactor used by
        // `formatters.log`. The redactor returns a fresh structure
        // (the caller's object is not mutated, matching the
        // formatters.log contract).
        logMethod(args, method) {
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (typeof arg === 'string') {
              args[i] = redactSensitiveTokens(arg)
            } else if (arg !== null && typeof arg === 'object') {
              args[i] = maskLog(arg as Record<string, unknown>)
            }
          }
          // pino's typing for the hook expects the rest-spread call.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return method.apply(this, args as any)
        },
      },
      messageKey: 'msg',
    },
    pino.multistream(streams),
  )

  initialized = true
  return rootLogger
}

/**
 * Internal: get the initialized root logger or throw.
 *
 * Exposed via the convenience getters below so callers don't have to
 * thread the logger through every function.
 */
function getRootLogger(): Logger {
  if (!rootLogger) {
    throw new Error(
      '[logger] Root logger not initialized. Call initLogger(projectRoot, setting) at startup before using childLogger().',
    )
  }
  return rootLogger
}

/**
 * Create a child logger tagged with the given component name. Every
 * record emitted via the returned logger will carry `"component": "<name>"`.
 *
 * Throws if the root logger has not been initialized — callers are
 * expected to use this from request-time code paths or guarded
 * lifecycle code that runs after initLogger().
 */
export function childLogger(component: string): Logger {
  return getRootLogger().child({ component: component || COMPONENT_FALLBACK })
}

/**
 * Console-backed minimal Logger surface used when a lazy child logger
 * is invoked before the root pino logger has been initialized. This
 * keeps unit tests that load server modules without booting the
 * server from crashing on incidental log calls (e.g. a config loader
 * emitting a warn when running standalone).
 */
function consoleFallbackLogger(component: string): Logger {
  const tag = `[${component}]`
  const fmt = (msgOrObj: unknown, msg?: string) => {
    if (typeof msgOrObj === 'string') return [tag, msgOrObj]
    return [tag, msg ?? '', msgOrObj]
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    info: (msgOrObj: unknown, msg?: string) =>
      console.info(...fmt(msgOrObj, msg)),
    warn: (msgOrObj: unknown, msg?: string) =>
      console.warn(...fmt(msgOrObj, msg)),
    error: (msgOrObj: unknown, msg?: string) =>
      console.error(...fmt(msgOrObj, msg)),
    debug: (msgOrObj: unknown, msg?: string) =>
      console.debug(...fmt(msgOrObj, msg)),
    trace: () => undefined,
    fatal: (msgOrObj: unknown, msg?: string) =>
      console.error(...fmt(msgOrObj, msg)),
    child: () => consoleFallbackLogger(component),
    flush: (cb?: () => void) => cb?.(),
    level: 'info',
  } as unknown as Logger
}

/**
 * Like childLogger() but resolved lazily on first method access, with
 * a console.* fallback if the root logger has not yet been
 * initialized. Use this when a module wants to keep a top-level
 * reference to a child logger without forcing initLogger() to run
 * before the import is evaluated (e.g. unit tests that import
 * server modules without booting the server). After initLogger()
 * runs, subsequent method calls route through the real pino logger.
 */
export function lazyChildLogger(component: string): Logger {
  return new Proxy({} as Logger, {
    get: (_t, prop) => {
      const l = rootLogger
        ? rootLogger.child({ component: component || COMPONENT_FALLBACK })
        : consoleFallbackLogger(component)
      const value = (l as unknown as Record<string, unknown>)[prop as string]
      return typeof value === 'function' ? (value as Function).bind(l) : value
    },
  })
}

/**
 * Convenience accessors for frequently-used component loggers. These
 * are getter-style (lazy) so they can be imported at module load time
 * even before initLogger() runs; access only happens after the server
 * has called initLogger().
 */
export const serverLogger = new Proxy({} as Logger, {
  get: (_t, prop) => {
    const l = childLogger('server')
    const value = (l as unknown as Record<string, unknown>)[prop as string]
    return typeof value === 'function' ? (value as Function).bind(l) : value
  },
})

export const tmuxLogger = new Proxy({} as Logger, {
  get: (_t, prop) => {
    const l = childLogger('tmux-bridge')
    const value = (l as unknown as Record<string, unknown>)[prop as string]
    return typeof value === 'function' ? (value as Function).bind(l) : value
  },
})

export const trustLogger = new Proxy({} as Logger, {
  get: (_t, prop) => {
    const l = childLogger('trust-prompt')
    const value = (l as unknown as Record<string, unknown>)[prop as string]
    return typeof value === 'function' ? (value as Function).bind(l) : value
  },
})

export const watcherLogger = new Proxy({} as Logger, {
  get: (_t, prop) => {
    const l = childLogger('watcher')
    const value = (l as unknown as Record<string, unknown>)[prop as string]
    return typeof value === 'function' ? (value as Function).bind(l) : value
  },
})

export const recipeLogger = new Proxy({} as Logger, {
  get: (_t, prop) => {
    const l = childLogger('recipe')
    const value = (l as unknown as Record<string, unknown>)[prop as string]
    return typeof value === 'function' ? (value as Function).bind(l) : value
  },
})

/**
 * Flush buffered records and exit. Used by global error handlers so
 * the last few log lines are not lost when the process dies.
 */
export function flushAndExit(code: number): void {
  if (!rootLogger) {
    process.exit(code)
    return
  }
  rootLogger.flush(() => process.exit(code))
}

/**
 * User-extension logging contract (DEC-017 v1.3 §11).
 *
 * Public-API shape exposed to user-extension `app/api/*.ts` modules
 * via `globalThis.kbContext.logger(name)`. Mirrors the renderer-side
 * `KbLogger` shape (debug / info / warn / error) so a recipe author
 * sees a consistent surface on both ends.
 */
export interface KbContextLogger {
  debug(msgOrData: string | object, msg?: string): void
  info(msgOrData: string | object, msg?: string): void
  warn(msgOrData: string | object, msg?: string): void
  error(msgOrData: string | object, msg?: string): void
}

export interface KbContext {
  /**
   * Returns a logger scoped to the supplied component name. The
   * `app.` prefix is added automatically — user code passes only
   * the recipe / handler name and the prefix is enforced at the
   * platform layer to keep the user-extension namespace clean.
   *
   * Throws if `component` is not a string or is empty / longer than
   * 64 characters; this is a programming error on the user side and
   * surfacing it loudly at first use is preferable to silently
   * mis-tagging records.
   */
  logger(component: string): KbContextLogger
}

const KB_CONTEXT_COMPONENT_MAX = 64

/**
 * Install `globalThis.kbContext` so user-extension server-side
 * modules can grab a logger without importing KovitoBoard internals.
 *
 * MUST be called after `initLogger()` and BEFORE any handler /
 * router that references `globalThis.kbContext` is loaded (e.g.
 * `mountAppApiRoutes`, `registerHandler`). Idempotent: a second
 * call replaces the binding with a fresh closure but does not throw.
 */
export function setupKbContext(): void {
  ;(globalThis as { kbContext?: KbContext }).kbContext = {
    logger(component: string): KbContextLogger {
      if (
        typeof component !== 'string' ||
        component.length === 0 ||
        component.length > KB_CONTEXT_COMPONENT_MAX
      ) {
        throw new Error(
          `kbContext.logger: invalid component name (must be a 1..${KB_CONTEXT_COMPONENT_MAX} char string): ${String(component)}`,
        )
      }
      return childLogger(`app.${component}`) as KbContextLogger
    },
  }
}

/**
 * Test-only: tear down `globalThis.kbContext` between cases so a
 * later test starts from a clean slate.
 */
export function _resetKbContextForTests(): void {
  delete (globalThis as { kbContext?: KbContext }).kbContext
}

/**
 * Test-only: reset the module-level logger state. Used by unit tests
 * that initialize the logger multiple times. Not intended for
 * production code.
 *
 * Important: pino-roll's underlying SonicBoom stream keeps writing
 * asynchronously after the last `logger.*` call. If the test deletes
 * the project root before that flush settles, the in-flight write
 * fails with ENOENT and surfaces as a Vitest "Unhandled Errors"
 * failure (which fails the run on CI even when every test passes).
 *
 * To prevent that race, we destroy the rolling file stream here so
 * pino-roll stops issuing writes against the about-to-be-removed
 * directory. Errors during destroy are swallowed because the stream
 * may already be closed in some test paths.
 */
export function _resetLoggerForTests(): void {
  if (fileStreamHandle) {
    try {
      fileStreamHandle.destroy()
    } catch {
      /* ignore: stream may already be closed */
    }
    fileStreamHandle = null
  }
  rootLogger = null
  initialized = false
}
