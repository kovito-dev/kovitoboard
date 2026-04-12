/**
 * Trust Prompt 検知ループ
 *
 * 仕様書 `docs/specs/trust-prompt-relay.md` v1.1 に準拠した実装。
 *
 * 責務:
 *   1. tmux ウィンドウごとに一定間隔で `capture-pane` を実行
 *   2. パターンマッチ（§4-1 / 初期セットは §4-1-2）で既知プロンプトを検出
 *   3. パターン不一致でも「idle + trust footer マッチ + 除外条件不成立」で入力待ちを検知
 *      → フォールバック UX に誘導（§4-2）
 *   4. UI から `trust_prompt_respond` を受けて `TmuxBridge.sendTrustPromptKeys` で応答送信
 *
 * 設計判断（Phase 5b 時点）:
 *   - 初期パターンは `src/server/trust-patterns.json` に外部化。サーバー起動時に
 *     `loadTrustPatterns(fs, path)` で読み込み、TrustPromptDetector に注入する
 *   - tmux ウィンドウ単位で `DetectorState` を持つ（`Map<windowName, DetectorState>`）
 *   - 新規ウィンドウ発見は 1 秒間隔で `listWindows()` を再スキャン
 *   - 検知ポーリング間隔は 200ms（仕様書 §4-2-1）
 *   - 除外条件・フッターマッチは検証ノート §4 のキャリブレーション結果に準拠
 */

import { chmodSync } from 'fs'
import type { TmuxBridge } from './tmux-bridge'
import type { FileAccessLayer } from './fs-layer'
import { getDebugTrustDir } from './paths'
import type {
  ServerToClientEvent,
  TrustPromptChoice,
  TrustPromptKind,
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
} from '../shared/ws-events'

// =========================
// 設定
// =========================

/** 検知ポーリング間隔 (ms)。仕様書 §4-2-1 */
export const POLL_INTERVAL_MS = 200

/** ウィンドウ一覧再スキャン間隔 (ms) */
export const WINDOW_DISCOVERY_INTERVAL_MS = 1000

/** idle 判定に必要な連続一致回数（2 回で 400ms 以上の無変化と判定） */
export const IDLE_CONFIRMATIONS = 2

/** `capture-pane -S -<lines>` で取得する行数（仕様書 §4-1-3） */
export const CAPTURE_LINES = 200

/** 検知済みイベントに含める rawBuffer の末尾行数 */
const RAW_BUFFER_DETECTED_TAIL_LINES = 30

/** フォールバックイベントに含める rawBuffer の末尾行数 */
const RAW_BUFFER_FALLBACK_TAIL_LINES = 50

// =========================
// 除外条件・フッター regex（状態ベース検知 §4-2-1）
// =========================

/**
 * 除外条件: 末尾非空行や capture 全体がこれらにマッチする場合、通常状態とみなす。
 * 検証ノート §4-2 発見 3 / §4-3 除外条件の 3 つを採用。
 */
const EXCLUDE_PATTERNS: RegExp[] = [
  /\? for shortcuts/, // 通常入力待ち
  /⎿\s+Running…/, // 処理中
  /✢\s+\w+…\s+\(thinking\)/, // thinking 中
]

/**
 * trust prompt のフッターパターン。末尾非空行がこれらのいずれかにマッチしたら
 * 「trust prompt 状態候補」と判定する。
 */
const TRUST_FOOTER_PATTERNS: RegExp[] = [
  /Esc to cancel · Tab to amend/, // Write / Edit / Bash / Sandbox-Network
  /Enter to confirm · Esc to cancel/, // Folder Trust
  /ctrl\+e to explain/, // Bash 専用の追加フッター
]

// =========================
// パターン定義
// =========================

/**
 * trust prompt のパターン定義 1 件
 * ソースは `src/server/trust-patterns.json`。loader がコンパイル済み
 * (`TrustPattern`) を返す。
 */
export interface TrustPattern {
  id: string
  kind: TrustPromptKind
  priority: number
  /** いずれか 1 つにマッチで確定 */
  matchAny: RegExp[]
  /** 末尾非空行のマッチ用フッター regex（先行フィルタ） */
  footer: RegExp
  /** capture group による付加情報抽出（失敗しても ID は確定する） */
  extract: Record<string, RegExp>
  /** 縮退表示を示す追加指標（存在すれば `degenerate: true` を UI に伝える） */
  degenerateForms?: RegExp[]
  /** UI 表示用の選択肢（送信キー付き） */
  choices: TrustPromptChoice[]
}

// =========================
// パターン JSON ローダー
// =========================

/**
 * `trust-patterns.json` のルート構造
 * 必須フィールドは `patterns` のみ。`version` / `compatibleClaudeCodeVersions`
 * は v0.1.0 では情報表示用で、ランタイム検証は行わない（v0.2.0 以降で追加予定）。
 */
interface TrustPatternFile {
  version?: string
  compatibleClaudeCodeVersions?: string[]
  patterns: RawTrustPattern[]
}

/**
 * JSON 上のパターン 1 件。regex 系フィールドは string で保持する。
 * loader が `RegExp` にコンパイルする際、multiline フラグ (`m`) を固定で付与する。
 */
interface RawTrustPattern {
  id: string
  kind: TrustPromptKind
  priority: number
  matchAny: string[]
  footer: string
  extract?: Record<string, string>
  degenerateForms?: string[]
  choices: TrustPromptChoice[]
}

/**
 * `trust-patterns.json` を読み込んで `TrustPattern[]` にコンパイルする。
 *
 * 失敗時は例外 throw。サーバー起動を止めて検知ループが空になる事故
 * （パターン 0 件で全プロンプトがフォールバックに流れる）を防ぐ。
 *
 * @param fs   FileAccessLayer（Phase 4 で導入済みの fs 抽象化）
 * @param path JSON ファイルの絶対パス
 */
export function loadTrustPatterns(fs: FileAccessLayer, path: string): TrustPattern[] {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf-8')
  } catch (err) {
    throw new Error(
      `trust-patterns.json の読み込みに失敗しました (${path}): ${(err as Error).message}`,
    )
  }

  let parsed: TrustPatternFile
  try {
    parsed = JSON.parse(text) as TrustPatternFile
  } catch (err) {
    throw new Error(
      `trust-patterns.json のパースに失敗しました (${path}): ${(err as Error).message}`,
    )
  }

  if (!parsed || !Array.isArray(parsed.patterns)) {
    throw new Error(
      `trust-patterns.json に patterns 配列がありません (${path})`,
    )
  }
  if (parsed.patterns.length === 0) {
    throw new Error(
      `trust-patterns.json の patterns が空です (${path})。検知ループが全件フォールバックに流れるため拒否します。`,
    )
  }

  return parsed.patterns.map((raw) => compileTrustPattern(raw, path))
}

/**
 * `RawTrustPattern` → `TrustPattern` へのコンパイル。
 * RegExp は multiline (`m`) フラグ固定で構築する。fixture 設計と実装（§4-1-2）が
 * すべて multiline 前提のため、JSON 上で flags を個別指定する必要はない。
 */
function compileTrustPattern(raw: RawTrustPattern, path: string): TrustPattern {
  if (!raw || typeof raw.id !== 'string' || typeof raw.kind !== 'string' || typeof raw.priority !== 'number') {
    throw new Error(
      `trust-patterns.json パターン定義が不完全です (${path}): ${JSON.stringify(raw)}`,
    )
  }
  if (!Array.isArray(raw.matchAny) || raw.matchAny.length === 0) {
    throw new Error(
      `trust-patterns.json パターン "${raw.id}" の matchAny が空です (${path})`,
    )
  }
  if (typeof raw.footer !== 'string') {
    throw new Error(
      `trust-patterns.json パターン "${raw.id}" に footer がありません (${path})`,
    )
  }
  if (!Array.isArray(raw.choices)) {
    throw new Error(
      `trust-patterns.json パターン "${raw.id}" の choices が配列ではありません (${path})`,
    )
  }

  try {
    return {
      id: raw.id,
      kind: raw.kind,
      priority: raw.priority,
      matchAny: raw.matchAny.map((s) => new RegExp(s, 'm')),
      footer: new RegExp(raw.footer, 'm'),
      extract: Object.fromEntries(
        Object.entries(raw.extract ?? {}).map(([k, s]) => [k, new RegExp(s, 'm')]),
      ),
      degenerateForms: raw.degenerateForms?.map((s) => new RegExp(s, 'm')),
      choices: raw.choices,
    }
  } catch (err) {
    throw new Error(
      `trust-patterns.json パターン "${raw.id}" の RegExp コンパイルに失敗しました: ${(err as Error).message}`,
    )
  }
}

// =========================
// パターンマッチエンジン
// =========================

export interface MatchResult {
  pattern: TrustPattern
  extracted: Record<string, string | null>
  degenerate: boolean
}

/**
 * capture 文字列に対して優先度順にパターンマッチを試みる。
 * 先行フィルタとして末尾非空行 (`footer`) を使い、マッチ候補を絞り込む。
 */
export class PatternMatcher {
  private patterns: TrustPattern[]

  constructor(patterns: TrustPattern[]) {
    // 優先度降順でソート
    this.patterns = [...patterns].sort((a, b) => b.priority - a.priority)
  }

  match(capture: string): MatchResult | null {
    const footerLine = lastNonEmptyLine(capture)

    // footer で候補を絞る（高速化）
    const candidates = this.patterns.filter((p) => p.footer.test(footerLine))
    if (candidates.length === 0) return null

    for (const pattern of candidates) {
      if (!pattern.matchAny.some((r) => r.test(capture))) continue

      const extracted: Record<string, string | null> = {}
      for (const [key, regex] of Object.entries(pattern.extract)) {
        const m = capture.match(regex)
        extracted[key] = m ? (m[1] ?? m[0]) : null
      }
      const degenerate = pattern.degenerateForms
        ? pattern.degenerateForms.some((r) => r.test(capture))
        : false
      return { pattern, extracted, degenerate }
    }
    return null
  }
}

// =========================
// 検知状態
// =========================

interface DetectorState {
  /** 直近 capture のハッシュ（idle 判定用） */
  lastCaptureHash: string
  /** 連続 idle 回数 */
  consecutiveIdleCount: number
  /** 直近で通知済みの promptId（重複検出抑止） */
  lastDetectedPromptId: string | null
  /** 直近通知時の choices（choiceId → keys 変換に使用） */
  lastChoices: TrustPromptChoice[]
}

// =========================
// 検知ループ本体
// =========================

export type BroadcastFn = (event: ServerToClientEvent) => void

export class TrustPromptDetector {
  private states = new Map<string, DetectorState>()
  private tickTimer: NodeJS.Timeout | null = null
  private windowDiscoveryTimer: NodeJS.Timeout | null = null
  private matcher: PatternMatcher
  private debug: boolean
  private debugDumpDir: string | null = null
  private debugDumpDirEnsured = false

  constructor(
    private tmux: TmuxBridge,
    patterns: TrustPattern[],
    private broadcast: BroadcastFn,
    private fs?: FileAccessLayer,
  ) {
    this.matcher = new PatternMatcher(patterns)
    this.debug = process.env.KOVITOBOARD_DEBUG_TRUST === '1'
    if (this.debug && this.fs) {
      this.debugDumpDir = getDebugTrustDir(this.fs)
    }
  }

  /** 検知ループを開始する（既に起動済みなら何もしない） */
  start(): void {
    if (this.tickTimer || this.windowDiscoveryTimer) return
    this.refreshWindows() // 初回即時反映
    this.tickTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS)
    this.windowDiscoveryTimer = setInterval(
      () => this.refreshWindows(),
      WINDOW_DISCOVERY_INTERVAL_MS,
    )
    if (this.debug) {
      console.error('[trust-detector] loop started')
    }
  }

  /** 検知ループを停止する（テスト・シャットダウン用） */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.windowDiscoveryTimer) {
      clearInterval(this.windowDiscoveryTimer)
      this.windowDiscoveryTimer = null
    }
    this.states.clear()
  }

  /**
   * UI からの choice モード応答を受けて tmux に送信する
   *
   * UI は `choiceId` のみを送り、実際の送信キー列は detector が
   * 直近通知時に保持した `lastChoices` から解決する。
   * これにより UI 側から任意のキーを送り込めない設計とする。
   *
   * @returns 送信成否（promptId 不整合・choice 未知も false を返す）
   */
  respondChoice(windowName: string, promptId: string, choiceId: string): boolean {
    const state = this.states.get(windowName)
    if (!state) {
      console.warn(`[trust-detector] 未知のウィンドウ: ${windowName}`)
      return false
    }
    if (state.lastDetectedPromptId !== promptId) {
      console.warn(
        `[trust-detector] promptId 不一致（破棄）: expected=${state.lastDetectedPromptId} got=${promptId}`,
      )
      return false
    }
    const choice = state.lastChoices.find((c) => c.id === choiceId)
    if (!choice) {
      console.warn(
        `[trust-detector] 未知の choiceId: ${choiceId} (available: ${state.lastChoices.map((c) => c.id).join(', ')})`,
      )
      return false
    }
    return this.tmux.sendTrustPromptKeys(windowName, choice.keys, false)
  }

  /**
   * fallback UX からの raw-keys 応答
   *
   * 文字列長上限 1024 文字（仕様書 §5-2-2）を課し、
   * literal モードで送信する。
   */
  respondRawKeys(windowName: string, promptId: string, rawKeys: string): boolean {
    const state = this.states.get(windowName)
    if (!state) {
      console.warn(`[trust-detector] 未知のウィンドウ: ${windowName}`)
      return false
    }
    if (state.lastDetectedPromptId !== promptId) {
      console.warn(
        `[trust-detector] promptId 不一致（破棄）: expected=${state.lastDetectedPromptId} got=${promptId}`,
      )
      return false
    }
    if (rawKeys.length > 1024) {
      console.warn(`[trust-detector] raw-keys 長すぎ (${rawKeys.length}): 破棄`)
      return false
    }
    return this.tmux.sendTrustPromptKeys(windowName, rawKeys, true)
  }

  // ===== 内部実装 =====

  /** tmux セッションの現在ウィンドウに合わせて state を同期する */
  private refreshWindows(): void {
    if (!this.tmux.hasSession()) {
      if (this.states.size > 0) this.states.clear()
      return
    }

    const windows = this.tmux.listWindows()
    const liveNames = new Set(
      windows.map((w) => w.name).filter((n) => n !== 'main'),
    )

    // 消えたウィンドウを削除
    for (const name of Array.from(this.states.keys())) {
      if (!liveNames.has(name)) {
        this.states.delete(name)
        if (this.debug) {
          console.error(`[trust-detector] state removed: ${name}`)
        }
      }
    }

    // 新規ウィンドウを追加
    for (const name of liveNames) {
      if (!this.states.has(name)) {
        this.states.set(name, {
          lastCaptureHash: '',
          consecutiveIdleCount: 0,
          lastDetectedPromptId: null,
          lastChoices: [],
        })
        if (this.debug) {
          console.error(`[trust-detector] state added: ${name}`)
        }
      }
    }
  }

  /** 全ウィンドウに対して 1 tick 分の検知を実行 */
  private tick(): void {
    for (const [windowName, state] of this.states) {
      try {
        this.detectForWindow(windowName, state)
      } catch (err) {
        console.error(`[trust-detector] detectForWindow エラー (${windowName}):`, err)
      }
    }
  }

  private detectForWindow(windowName: string, state: DetectorState): void {
    const capture = this.tmux.capturePane(windowName, CAPTURE_LINES)
    if (!capture) return

    const hash = simpleHash(capture)
    const changed = hash !== state.lastCaptureHash

    if (changed) {
      state.lastCaptureHash = hash
      state.consecutiveIdleCount = 0

      // capture が変化した場合、既に通知済みのプロンプトは「消えた」とみなす
      if (state.lastDetectedPromptId) {
        this.broadcast({
          type: 'trust_prompt_resolved',
          payload: { promptId: state.lastDetectedPromptId, windowName },
        })
        if (this.debug) {
          console.error(
            `[trust-detector] resolved (capture changed): ${state.lastDetectedPromptId}`,
          )
        }
        state.lastDetectedPromptId = null
        state.lastChoices = []
      }
      return
    }

    // capture 変化なし → idle カウント増
    state.consecutiveIdleCount += 1

    // idle 判定に至らない場合は何もしない
    if (state.consecutiveIdleCount < IDLE_CONFIRMATIONS) return

    // 既に通知済みならこれ以上何もしない（応答待ち）
    if (state.lastDetectedPromptId) return

    // 除外条件: 通常入力待ち・処理中・thinking 中は無視
    if (this.isExcluded(capture)) return

    // パターンマッチ (S-1)
    const matched = this.matcher.match(capture)
    if (matched) {
      const promptId = generatePromptId(windowName)
      state.lastDetectedPromptId = promptId
      state.lastChoices = matched.pattern.choices
      const payload: TrustPromptDetectedPayload = {
        promptId,
        windowName,
        kind: matched.pattern.kind,
        patternId: matched.pattern.id,
        detail: matched.extracted,
        degenerate: matched.degenerate,
        choices: matched.pattern.choices,
        rawBuffer: tailLines(capture, RAW_BUFFER_DETECTED_TAIL_LINES),
      }
      this.broadcast({ type: 'trust_prompt_detected', payload })
      if (this.debug) {
        console.error(
          `[trust-detector] matched: ${matched.pattern.id} on ${windowName} (degenerate=${matched.degenerate})`,
        )
        this.writeDump(windowName, capture, {
          trigger: 'detected',
          patternId: matched.pattern.id,
          kind: matched.pattern.kind,
          extracted: matched.extracted,
          degenerate: matched.degenerate,
          footerLine: lastNonEmptyLine(capture),
        })
      }
      return
    }

    // パターン不一致 + footer マッチ → fallback UX へ誘導 (S-2)
    if (this.hasTrustFooter(capture)) {
      const promptId = generatePromptId(windowName, 'fallback')
      state.lastDetectedPromptId = promptId
      state.lastChoices = [] // fallback 時は raw-keys 応答のみ受け付ける
      const payload: TrustPromptFallbackPayload = {
        promptId,
        windowName,
        rawBuffer: tailLines(capture, RAW_BUFFER_FALLBACK_TAIL_LINES),
      }
      this.broadcast({ type: 'trust_prompt_fallback', payload })
      if (this.debug) {
        console.error(`[trust-detector] fallback (unknown pattern) on ${windowName}`)
        this.writeDump(windowName, capture, {
          trigger: 'fallback',
          patternId: null,
          kind: null,
          extracted: null,
          degenerate: false,
          footerLine: lastNonEmptyLine(capture),
        })
      }
    }
  }

  private isExcluded(capture: string): boolean {
    return EXCLUDE_PATTERNS.some((r) => r.test(capture))
  }

  private hasTrustFooter(capture: string): boolean {
    const line = lastNonEmptyLine(capture)
    return TRUST_FOOTER_PATTERNS.some((r) => r.test(line))
  }

  // ===== デバッグダンプ (Phase 5e) =====

  /**
   * 検知イベント発火時にダンプファイルを出力する。
   * `KOVITOBOARD_DEBUG_TRUST=1` 有効時のみ呼ばれる。
   *
   * ダンプ先: `.kovitoboard/debug/trust-prompt/{timestamp}-{windowName}.json`
   * 仕様書 §7-1 / §8-3 準拠。
   */
  private writeDump(
    windowName: string,
    capture: string,
    result: {
      trigger: 'detected' | 'fallback'
      patternId: string | null
      kind: string | null
      extracted: Record<string, string | null> | null
      degenerate: boolean
      footerLine: string
    },
  ): void {
    if (!this.fs || !this.debugDumpDir) return

    try {
      // ディレクトリ確保（初回のみ）
      if (!this.debugDumpDirEnsured) {
        this.fs.mkdirSync(this.debugDumpDir, { recursive: true })
        // ディレクトリ権限を 0700 に設定（仕様書 §8-3: 機密情報保護）
        // fs-layer に chmod がないため Node.js fs を直接使用（デバッグ専用のベストエフォート）
        try {
          chmodSync(this.debugDumpDir, 0o700)
        } catch {
          // 権限変更に失敗してもダンプ自体は続行
        }
        this.debugDumpDirEnsured = true
      }

      const now = new Date()
      const ts = now.toISOString().replace(/[:.]/g, '-')
      // windowName にファイル名不正文字が含まれる可能性に備えてサニタイズ
      const safeName = windowName.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `${ts}-${safeName}.json`
      const filepath = `${this.debugDumpDir}/${filename}`

      const dump = {
        timestamp: now.toISOString(),
        windowName,
        trigger: result.trigger,
        match: {
          patternId: result.patternId,
          kind: result.kind,
          extracted: result.extracted,
          degenerate: result.degenerate,
        },
        footerLine: result.footerLine,
        excludeMatched: EXCLUDE_PATTERNS.map((r) => ({
          pattern: r.source,
          matched: r.test(capture),
        })),
        footerPatterns: TRUST_FOOTER_PATTERNS.map((r) => ({
          pattern: r.source,
          matched: r.test(result.footerLine),
        })),
        captureBuffer: capture,
        _warning:
          'このファイルには tmux の生バッファが含まれています。' +
          '機密情報（パスワード・トークン等）が含まれている可能性があるため、' +
          'Issue に貼り付ける前に内容を確認してください。',
      }

      this.fs.writeFileSync(filepath, JSON.stringify(dump, null, 2), 'utf-8')
      console.error(`[trust-detector] dump written: ${filename}`)
    } catch (err) {
      console.error('[trust-detector] dump write failed:', err)
    }
  }
}

// =========================
// ユーティリティ
// =========================

/** capture 末尾から最初の非空行を返す */
export function lastNonEmptyLine(capture: string): string {
  const lines = capture.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i]
  }
  return ''
}

/** capture の末尾 n 行を結合して返す */
export function tailLines(capture: string, n: number): string {
  const lines = capture.split('\n')
  return lines.slice(-n).join('\n')
}

/** 軽量な文字列ハッシュ（変化検出のみが目的、衝突耐性は不要） */
function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

function generatePromptId(windowName: string, prefix = 'prompt'): string {
  return `${prefix}:${windowName}:${Date.now().toString(36)}`
}
