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
 * 設計判断（Phase 5a 時点）:
 *   - 初期パターンは本ファイル内にハードコード（Phase 5b で `trust-patterns.json` に外部化予定）
 *   - tmux ウィンドウ単位で `DetectorState` を持つ（`Map<windowName, DetectorState>`）
 *   - 新規ウィンドウ発見は 1 秒間隔で `listWindows()` を再スキャン
 *   - 検知ポーリング間隔は 200ms（仕様書 §4-2-1）
 *   - 除外条件・フッターマッチは検証ノート §4 のキャリブレーション結果に準拠
 */

import type { TmuxBridge } from './tmux-bridge'
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
 * Phase 5b で `trust-patterns.json` に外部化するが、構造は揃える。
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

/**
 * 初期パターンセット（仕様書 §4-1-2 / 検証ノート §5-1 準拠）
 *
 * Phase 5b で `trust-patterns.json` に外部化する予定。
 * 変更時は `docs/design/verification-fixtures/claude-2.1.97/` の fixture で
 * マッチ確認すること。
 */
export const INITIAL_PATTERNS: TrustPattern[] = [
  {
    id: 'folder-trust-initial',
    kind: 'folder-trust',
    priority: 100,
    matchAny: [
      /Accessing workspace:/,
      /Quick safety check: Is this a project you created/,
      /Yes, I trust this folder/,
    ],
    footer: /Enter to confirm · Esc to cancel/,
    extract: {
      workspace: /Accessing workspace:\s*\n\s*\n\s*(.+?)\s*\n/,
    },
    choices: [
      { id: 'yes', label: 'Yes, I trust this folder', keys: 'Enter' },
      { id: 'no', label: 'No, exit', keys: '2\n' },
    ],
  },
  {
    id: 'edit-update-existing',
    kind: 'edit',
    priority: 90,
    matchAny: [
      /Do you want to make this edit to .+\?/,
      /^● Update\(.+\)/m,
      /^\s*Edit file\s*$/m,
    ],
    footer: /Esc to cancel · Tab to amend/,
    extract: {
      path: /● Update\((.+?)\)/,
    },
    choices: [
      { id: 'yes', label: 'Yes', keys: '1\n' },
      { id: 'yes-session', label: 'Yes, allow all edits during this session', keys: '2\n' },
      { id: 'no', label: 'No', keys: '3\n' },
    ],
  },
  {
    id: 'write-create-new',
    kind: 'write',
    priority: 90,
    matchAny: [
      /Do you want to create .+\?/,
      /^● Write\(.+\)/m,
      /^\s*Create file\s*$/m,
    ],
    footer: /Esc to cancel · Tab to amend/,
    extract: {
      path: /● Write\((.+?)\)/,
    },
    choices: [
      { id: 'yes', label: 'Yes', keys: '1\n' },
      { id: 'yes-session', label: 'Yes, and allow for this session', keys: '2\n' },
      { id: 'no', label: 'No', keys: '3\n' },
    ],
  },
  {
    id: 'bash-command',
    kind: 'bash',
    priority: 85,
    matchAny: [
      /Do you want to proceed\?/,
      /^\s*Bash command\s*$/m,
      /^● Bash\(/m,
    ],
    // Bash は共通フッターに加えて `· ctrl+e to explain` が付くため、それを footer として採用
    footer: /ctrl\+e to explain/,
    extract: {
      command: /● Bash\((.+?)\)/,
    },
    degenerateForms: [/Unhandled node type: file_redirect/],
    choices: [
      { id: 'yes', label: 'Yes', keys: '1\n' },
      { id: 'yes-session', label: 'Yes, and allow this session', keys: '2\n' },
      { id: 'no', label: 'No', keys: '3\n' },
    ],
  },
  {
    id: 'sandbox-network-escape',
    kind: 'sandbox-network',
    priority: 80,
    matchAny: [
      /Network request outside of sandbox/,
      /Do you want to allow this connection\?/,
      /Host: .+$/m,
    ],
    footer: /Esc to cancel · Tab to amend/,
    extract: {
      host: /Host: (.+?)$/m,
    },
    choices: [
      { id: 'yes', label: 'Yes', keys: '1\n' },
      { id: 'yes-session', label: 'Yes, and allow this host', keys: '2\n' },
      { id: 'no', label: 'No', keys: '3\n' },
    ],
  },
]

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

  constructor(
    private tmux: TmuxBridge,
    patterns: TrustPattern[],
    private broadcast: BroadcastFn,
  ) {
    this.matcher = new PatternMatcher(patterns)
    // Phase 5e でダンプ出力等に拡張予定
    this.debug = process.env.KOVITOBOARD_DEBUG_TRUST === '1'
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
