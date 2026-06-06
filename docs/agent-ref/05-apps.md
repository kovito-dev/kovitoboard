# 05. 独自アプリ開発（`app/` ディレクトリ）

**対象 KB バージョン:** v0.2.2
**最終更新:** 2026-05-31

> 📖 **この章を読むタイミング:** INDEX.md の「自分だけのアプリを作りたい／app/ の構造／独自 API を追加したい／アプリを削除したい」から誘導された場合。

---

## この章の目的

KB の `app/` ディレクトリ（ユーザー拡張領域）を理解し、独自のページ・API・スタイルを追加できるようになることを目的とします。レシピとの使い分けも明確にします。

## 目次

- §1 `app/` ディレクトリとは
- §2 独自アプリを作る流れ
- §3 `app/` の構造
- §4 API ハンドラの追加（ユーザー定義のバックエンド API）
- §5 レシピとの違い
- §6 レシピとしてエクスポートする方法
- §7 事例: Intel ビュアー風アプリ
- §8 長時間処理を伴う BE 付きアプリのパターン
- §9 Ambient sidebar に内部状態を公開する（β-method）
- §10 アプリの無効化・削除

---

## §1 `app/` ディレクトリとは

`app/` は **ユーザーが自由に拡張を追加できる専用領域** です。KB 本体（`src/`）とは物理的に分離されており、`git pull` で KB をアップデートしても衝突しません。

### 1.1 設計原則

- **P1 コア不可侵:** ユーザーは `src/` 配下を変更せず、変更は `app/` に限定
- **P2 存在任意:** `app/` が無くても KB は完全動作（デフォルト UI）
- **P3 宣言的登録:** メニュー登録はハードコードではなく `app/menu.ts` で宣言
- **P4 標準技術:** Vite / Express の標準機能のみ（特殊な仕組み無し）

#### 1.1.1 補足: コア（`src/`）を直接改変したい場合

KB は OSS（リポジトリ全体が手元にある）ため、技術的には `src/` 配下も自由に改変できます。「P1 コア不可侵」は **規範であって強制ではありません**。

ただし `src/` を直接改変すると以下のトレードオフが発生します:

- **アップデート追従が困難:** `git pull` で KB をアップデートする際、改変箇所と上流の変更が衝突します。手動マージが必要です
- **レシピ・`app/` の前提が崩れる可能性:** レシピシステム（§5 / [`04-recipes.md`](./04-recipes.md)）や `app/` ローダー（§4）はコアの内部 API を前提に動いています。該当箇所を改変するとレシピや既存アプリが動作しなくなる場合があります
- **配布できない:** 改変したコアは他人に渡せません（自分専用の fork として運用することになります）

「コア機能そのものを拡張したい」というニーズが強い場合、まず [`07-advanced.md`](./07-advanced.md) の選択肢（`app/` で実現する迂回パターン）を検討し、それでも足りない場合に最終手段として `src/` 改変または upstream への PR を選択してください。

### 1.2 権限モデル

`app/` 配下のコードは **Node.js / React のフル権限** で実行されます。外部 API 叩き放題・ファイル読み書き放題です。その代わり「自分で書いたコードの責任は自分で負う」モデルです。

レシピ（§5 で詳述）がサンドボックス内で動くのと対照的です。

### 1.3 `.gitignore` 扱い

`app/` は `.gitignore` 対象です。つまり KB を Git 管理していても、ユーザー作成コードはコミットされません。**自分で別の場所にバックアップするか、別リポジトリで管理してください。**

### 1.4 `app.example/` の役割

KB リポジトリには `app.example/`（Git 管理対象）が同梱されており、`app/` のテンプレートとして使えます。初回は次で始めます:

```bash
cp -r app.example app
```

---

## §2 独自アプリを作る流れ

### 2.1 最短手順

1. `app/` が無ければ `cp -r app.example app` で雛形を作る
2. `app/menu.ts` を開いて新しいメニューエントリを追加
3. `app/pages/MyPage.tsx` を作成（React コンポーネント）
4. 必要なら `app/api/my-data.ts` を追加（Express Router）
5. KB を起動（または FE はホットリロード、BE は再起動）

### 2.2 Claude Code の支援を活用する

KB の「Kovito 開発者」エージェントに依頼すると、`app.example/` を参考にしたコードを生成してくれます。例:

> 「`app/` にプロジェクト内の Markdown 一覧を表示するページを追加してください」

エージェントは `app.example/` の実装パターンを読んでから、`app/pages/` と `app/api/` にコードを配置します。

---

## §3 `app/` の構造

### 3.1 ディレクトリ構成

```
app/
├── menu.ts                ← メニュー定義（必須、宣言的）
├── pages/                 ← React ページコンポーネント
│   └── MyDashboard.tsx
├── api/                   ← Express Router ベースの BE エンドポイント
│   └── my-data.ts
├── styles/                ← カスタム CSS
│   └── custom.css
└── data/                  ← （レシピの scope `own-data` が使う領域）
```

### 3.2 `app/menu.ts`（必須）

メニューエントリを宣言するファイルです。

```typescript
import type { AppMenuEntry } from '../src/shared/app-types'

export const menuEntries: AppMenuEntry[] = [
  {
    id: 'my-dashboard',
    label: 'ダッシュボード',
    icon: 'dashboard',
    component: () => import('./pages/MyDashboard'),
  },
]
```

フィールドの意味:

- `id`: 一意。コアの `agents` / `sessions` と被らないこと
- `label`: サイドバーに表示される名前
- `icon`: アイコンキー（`sessions`・`folder`・`settings`・`agents`・`dashboard`・`seeds`・`content`・`git`・`slides`・`brands`・`devroom` から選択。該当なしは `folder` にフォールバック）
- `component`: ページの動的インポート（default export が React コンポーネント）

### 3.3 `app/pages/*.tsx`

普通の React コンポーネントとして書きます。`default export` 必須。

```typescript
import { useState, useEffect } from 'react'

export default function MyDashboard() {
  const [count, setCount] = useState(0)
  return (
    <div className="p-6">
      <h1>ダッシュボード</h1>
      <button onClick={() => setCount(count + 1)}>
        クリック {count}
      </button>
    </div>
  )
}
```

ユーザーページには **サイドバーが付きません**（メインエリア全体を使用）。独自のサイドバーが必要ならコンポーネント内で自前レイアウトしてください。

### 3.4 `app/styles/*.css`

カスタム CSS を置けます。コアスタイルの **後** に適用されるため、CSS Custom Properties（`--accent-text` 等）の上書きが可能です。

```css
/* app/styles/custom.css */
:root {
  --accent-text: #10b981;  /* アクセントカラーを緑に変更 */
}
```

利用可能な変数の一覧は `src/renderer/styles/theme.css` を参照してください。

---

## §4 API ハンドラの追加（ユーザー定義のバックエンド API）

### 4.1 ファイル命名と自動マウント

API ファイルには **フラット配置** と **ネスト配置** の 2 系統があります。どちらも `.ts` / `.js` ファイルを **サーバー起動時に自動マウント** します。

#### フラット配置（従来）

`app/api/` 直下に置くパターン。単発の API を足したいときに向きます。

| ファイル | マウント先 |
|---|---|
| `app/api/my-data.ts` | `/api/ext/my-data` |
| `app/api/intel.ts` | `/api/ext/intel` |

#### ネスト配置（アプリ単位）

`app/{app-name}/api/` 直下に置くパターン。アプリに属するコードを 1 ディレクトリに凝集させたいときに向きます（§8 の長時間処理パターン、複数ファイル構成の独自アプリ）。

| ファイル | マウント先 |
|---|---|
| `app/research-reports/api/start-research.ts` | `/api/ext/research-reports/start-research` |
| `app/research-reports/api/status.ts` | `/api/ext/research-reports/status` |
| `app/my-app/api/list.ts` | `/api/ext/my-app/list` |

#### 共通の制約

- **階層は 1 段のみ** — フラットは `app/api/*.ts`、ネストは `app/*/api/*.ts`。それ以上深いサブディレクトリはスキャンされません
- 先頭が `_` のファイル（例: `_helpers.ts`）はスキップ
- 読み込みは **起動時 1 回**。BE の変更は再起動必須
- `app/api/` はフラット配置専用の予約ディレクトリです（ネスト配置のアプリ名として `api` は使えません）
- `{app-name}` は小文字英数字とハイフンのみ推奨（`/^[a-z][a-z0-9-]{0,63}$/`）
- 同じマウントパスが重複した場合は先勝ち + 起動ログに警告

### 4.2 基本例

```typescript
// app/api/my-data.ts
import { Router } from 'express'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ message: 'Hello from my-data' })
})

router.get('/detail', (_req, res) => {
  res.json({ detail: '...' })
})

export default router
```

フロントから呼び出す:

```typescript
fetch('/api/ext/my-data').then((r) => r.json()).then(console.log)
```

### 4.3 名前空間

すべてのユーザー定義 API は `/api/ext/` プレフィックス配下に置かれます。コア API（`/api/sessions` 等）とは名前衝突しません。

```
/api/sessions      ← コア（触らない）
/api/agents        ← コア
/api/ext/my-data   ← ユーザー定義
/api/ext/intel     ← ユーザー定義
```

### 4.4 権限の範囲

`app/api/*.ts` は Node.js でフル権限実行されます:

- ファイルシステム全域へのアクセス可能
- 外部 HTTP・shell 実行等も可能
- データベース・外部 API 連携も可能

**自己責任領域です。** 悪意あるコードは自作した瞬間に全権限で動きます。第三者から受け取ったコードを `app/api/` に置くときは細心の注意を払ってください（基本はレシピ経由で受け取るのが安全）。

---

## §5 レシピとの違い

### 5.1 比較表

| 項目 | ユーザー定義 BE API（`app/api/`） | レシピ |
|---|---|---|
| 実行モデル | Node.js フル権限 | 宣言的 handler（サンドボックス） |
| コード記述 | TypeScript を自由に | `recipe.yaml` で handler 呼び出しを宣言するだけ |
| 権限 | 制限なし | `scope` で宣言した範囲のみ |
| 第三者配布 | 不可（フル権限コードは安全に渡せない） | 可（サンドボックスで安全） |
| KB 更新への耐性 | `app/` は `.gitignore` で守られる | インストール情報も `app/` 配下で同様 |
| ホットロード | FE ○ / BE × | ○ |

### 5.2 どちらを選ぶか

- **自分専用 + 複雑な処理** → `app/api/` で書く
- **他人に渡したい or 公式レシピに昇格させたい** → レシピ化する
- **両方必要** → まず `app/` で作り、安定したらレシピに書き出す（§6）

### 5.3 信頼モデル（ユーザー向けメッセージ）

KB の README にも書かれる原則:

> - **レシピ（第三者配布を想定）:** サンドボックス内で動く。scope で権限が可視化される
> - **ユーザー定義のバックエンド API（自作のみ想定）:** フル権限・自己責任

この境界を KB は構造的に維持します。ユーザー定義 API にはレシピのような権限制限はかかりません。

---

## §6 レシピとしてエクスポートする方法

`app/` 配下で作ったものを他人に渡せる形にするには、[`04-recipes.md`](./04-recipes.md) §4 の手順でレシピ化します。

### 6.1 エクスポートの前提条件

- FE 成果物（`app/pages/*.tsx`・スタイル・メニュー登録）のみエクスポート可能
- `app/<appId>/api/` 配下にカスタムバックエンドコードを含むアプリは **エクスポートが拒否されます**（HTTP 400 `CustomBeNotExportable`）。詳細と action-first メッセージ（書き直す / 手順書化する の 2 択誘導）は [`04-recipes.md`](./04-recipes.md) §4.3.1 を参照
  - 必要な BE 機能が Category A handler（`04-recipes.md` §6.2 参照）で表現できれば、レシピ化時に宣言的 handler に書き換えて書き出せる
  - Category A で表現できない処理を含む場合、レシピとしては出せない（自作ユーザーにしか動かない）

### 6.2 書き出し後の流れ

1. `.zip` / `.yaml` が生成される
2. ファイルを他人に渡す（メール・共有ドライブ等）
3. 受け取った人は [`04-recipes.md`](./04-recipes.md) §2 の手順でインストール

---

## §7 事例: Intel ビュアー風アプリ

v0.1.0 のオンボーディング想定シナリオとして、`app/` で Intel レポート閲覧機能を作る例を示します。

### 7.1 要件

- プロジェクト内の `intel/YYYY-MM-DD.md` を一覧表示
- 選択するとプレビューで中身を表示
- サイドバーに「Intel」メニューを追加

### 7.2 最小構成

**`app/menu.ts`:**

```typescript
import type { AppMenuEntry } from '../src/shared/app-types'

export const menuEntries: AppMenuEntry[] = [
  {
    id: 'intel-viewer',
    label: 'Intel',
    icon: 'content',
    component: () => import('./pages/IntelViewer'),
  },
]
```

**`app/pages/IntelViewer.tsx`:**

```typescript
import { useState, useEffect } from 'react'

export default function IntelViewer() {
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')

  useEffect(() => {
    fetch('/api/ext/intel').then((r) => r.json()).then((d) => setFiles(d.files))
  }, [])

  useEffect(() => {
    if (!selected) return
    fetch(`/api/ext/intel/content?path=${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((d) => setContent(d.content))
  }, [selected])

  return (
    <div className="p-6">
      <h1>Intel レポート一覧</h1>
      <ul>
        {files.map((f) => (
          <li key={f}>
            <button onClick={() => setSelected(f)}>{f}</button>
          </li>
        ))}
      </ul>
      {content && <pre className="mt-4">{content}</pre>}
    </div>
  )
}
```

**`app/api/intel.ts`:**

```typescript
import { Router } from 'express'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const router = Router()
const intelDir = join(process.cwd(), 'intel')

router.get('/', (_req, res) => {
  try {
    const files = readdirSync(intelDir).filter((f) => f.endsWith('.md'))
    res.json({ files })
  } catch {
    res.json({ files: [] })
  }
})

router.get('/content', (req, res) => {
  const path = String(req.query.path || '')
  // ⚠️ 本番では path トラバーサル対策を必ず実装してください
  const full = join(intelDir, path)
  const content = readFileSync(full, 'utf-8')
  res.json({ content })
})

export default router
```

### 7.3 これをレシピにしたい場合

`app/api/intel.ts` の処理は、Category A の `list-files` + `read-file` handler で表現可能です。レシピ化すると以下のような宣言になります:

```yaml
api:
  scopes:
    - project-read
  handlers:
    - name: list-files
      args: { path: intel, filter: "*.md" }
    - name: read-file
      args: { path: "${selected}" }
```

ただし本格的に書き換えるには path トラバーサル対策等も見直す必要があります。レシピ化の支援は「Kovito 開発者」エージェントに依頼するのが確実です。

---

## §8 長時間処理を伴う BE 付きアプリのパターン

§7 は即座に結果が返る処理でしたが、**Web 検索・外部 API 連携・長時間の生成処理** など、数秒〜数十分かかる処理を扱う場合、以下のパターンを推奨します。

### 8.1 ジョブキュー + ポーリング構成

処理を同期 API の応答内で完結させず、「起動 → 進行中 → 完了」の 3 状態に分けて扱います。

- 起動 API は即座に `jobId` を返す（処理は背後で走る）
- フロントは `jobId` を使ってステータス API を定期ポーリングする（間隔 10 秒を推奨）
- ステータス値は `queued | running | completed | failed` の 4 値に揃える
- 完了後にデータ取得 API を 1 回呼ぶ

WebSocket を使わないのは、BE 依存を増やすと `app/` の導入障壁が上がるためです。ポーリングで支障が出るスケール（秒単位の更新が必要等）になるまでは、シンプルな HTTP で十分です。

### 8.2 データとコードの分離

長時間処理の生成物は `app/` 配下ではなく、**運用データ領域 `.kovitoboard/{app-name}/` に保存** します。

| 種類 | 置き場所 | 理由 |
|---|---|---|
| コード（`.ts` / `.tsx`） | `app/{app-name}/` | Git 管理（ユーザー判断でバックアップ）対象、レシピ化の出発点 |
| ジョブデータ（レポート本文・ログ等） | `.kovitoboard/{app-name}/` | `.gitignore` 扱いが一貫し、誤コミット事故が起きにくい |

ジョブ一覧のメタデータは JSONL（1 行 1 ジョブの追記オンリー）で持つと、同時書き込み時の破損リスクが下がります。

### 8.3 tmux サブセッションから Claude Code を呼ぶ

Web 検索や生成処理を Claude Code に任せたい場合、**メインセッション（ユーザー対話中のセッション）を占有せずに独立した tmux pane で処理を走らせる** 構成が基本です。

- `src/server/tmux-bridge.ts` / `session-manager.ts` をユーザー定義 BE API から import し、サブセッションを起動
- プロンプト雛形は `app/{app-name}/prompts/*.md` に配置（Git 管理したいテキストはこちら）
- 完了検知は以下のいずれか:
  - tmux 出力のパターンマッチ（「completed」等の特定文字列）
  - 成果物ファイル（`.kovitoboard/{app-name}/{job-id}/status.json`）の監視

セッション管理は既存機構をそのまま利用します。サブセッション側のログや中間成果物も `.kovitoboard/{app-name}/{job-id}/` 配下に集約すると、後の運用（削除・再実行・デバッグ）が楽になります。

### 8.4 ディレクトリ構成例

```
app/{app-name}/
├── page.tsx               ← 入力フォーム + 一覧 + 選択表示
├── api/
│   ├── start.ts           ← ジョブ起動（jobId 返却）
│   ├── status.ts          ← ポーリング用
│   ├── list.ts            ← 完了ジョブ一覧
│   └── get.ts             ← 個別結果取得
└── prompts/
    └── worker.md          ← サブセッション用システムプロンプト

.kovitoboard/{app-name}/
├── jobs.jsonl             ← ジョブ一覧メタデータ（追記のみ）
└── {job-id}/
    ├── status.json        ← { status, startedAt, finishedAt, error? }
    ├── result.md          ← 本体成果物
    └── sources.json       ← 付随データ（あれば）
```

`api/start.ts` の核になる流れは以下のような形です（抜粋）:

```typescript
// app/api/start.ts
import { Router } from 'express'
import { createSession } from '../../src/server/session-manager'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const router = Router()
const dataDir = join(process.cwd(), '.kovitoboard', 'my-app')

router.post('/', async (req, res) => {
  const jobId = `job-${Date.now()}`
  mkdirSync(join(dataDir, jobId), { recursive: true })
  appendFileSync(join(dataDir, 'jobs.jsonl'),
    JSON.stringify({ jobId, theme: req.body.theme, status: 'queued', startedAt: new Date().toISOString() }) + '\n')

  // サブセッションを起動して非同期に処理を回す（await しない）
  createSession({ label: jobId, promptPath: 'app/my-app/prompts/worker.md',
    vars: { JOB_ID: jobId, OUTPUT_DIR: join(dataDir, jobId) } })

  res.json({ jobId })
})

export default router
```

`api/status.ts` 側は `.kovitoboard/{app-name}/{job-id}/status.json` を読んで返すだけの薄い実装で構いません。

### 8.5 参考実装

[`app.example/research-reports/`](../../app.example/research-reports/) を参照してください。調査依頼 → Web 検索 → レポート生成 → 一覧表示までの一連の流れが実装されています。本章 §8.1〜§8.4 のパターンがそのまま適用されている具体例です。

### 8.6 このパターンが適さないケース

- **処理が 3 秒以内に終わる** → §7 の同期パターンで十分。ジョブ ID や status.json を設けるオーバーヘッドのほうが大きくなります
- **第三者への配布が目的** → レシピ化を先に検討してください。サブセッション起動は Category A では表現できないため、レシピ化は困難です
- **完全オフラインで動く必要がある** → Web 検索は Claude Code 経由（WebFetch）になるため、前提が崩れます

---

## §9 Ambient sidebar に内部状態を公開する（β-method）

KovitoBoard には、画面右側に常駐する **Ambient Session Sidebar** があります。サイドバーから問い合わせると、エージェントには現在の URL・メニュー・accessibility tree が自動で渡りますが、**画面上に表示されていない内部状態**（選択中のレポート ID、適用中フィルタ、ジョブの進行状況など）はそのままでは伝わりません。

`window.kb.exposeContext(payload)` を使うと、アプリ作者が任意の状態を「最新値 1 個」だけ公開できます。サイドバーは送信時にこの値を読み取り、`[ExposedContext]` セクションとしてエージェントへのメッセージに含めます。

### 9.1 使い方

```tsx
import { useEffect } from 'react'

export default function ResearchReportsPage() {
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const [filter, setFilter] = useState({ status: 'all', topic: '' })

  // 状態が変わるたびに最新値を公開
  useEffect(() => {
    window.kb?.exposeContext({
      selectedReportId,
      filter,
      visibleReportCount: 12,
    })
  }, [selectedReportId, filter])

  return <div>...</div>
}
```

### 9.2 仕様

| 項目 | 内容 |
|---|---|
| 引数 | プレーンな JSON シリアライズ可能オブジェクト |
| 上書き挙動 | 呼び出すたびに**完全置換**（マージしません） |
| サイズ上限 | シリアライズ後 **100 KB** |
| 上限超過時 | 拒否 + コンソール警告。前回値はそのまま残ります |
| 利用可能タイミング | アプリ起動後いつでも（recipe page mount に依存しません） |
| サイドバー側での読み取り | サイドバーで送信ボタンが押された瞬間の最新値 |

### 9.3 設計のヒント

- **頻繁に変わる値（マウス座標等）は公開しないでください。** 100KB 上限内とはいえ、コンテキスト全体のトークン消費が増えます
- **関連する値はまとめて 1 オブジェクトに。** 部分更新ができないため、変更があるたびに全体を渡す前提で構造化してください
- **個人情報・機微データは公開しないでください。** Ambient sidebar 経由で Claude に送られるため、データ取扱い方針（[09-data-handling.md](./09-data-handling.md)）の対象です

### 9.4 α-method（画面要素の選択）との違い

サイドバーには「画面要素を選択」ボタンもあります（α-method）。両者の使い分け:

| | α-method（画面要素を選択） | β-method（exposeContext） |
|---|---|---|
| トリガ | ユーザーが明示的にクリック | アプリが自動で公開 |
| 内容 | 選択した DOM 要素のテキスト + 周辺ツリー | アプリ作者が定義した任意の状態 |
| 適する場面 | 「この行について教えて」など UI 要素を指す対話 | 「現在の選択状態に基づいて〜」など内部状態に基づく対話 |
| アプリ側のコード | 不要 | useEffect 内で `window.kb.exposeContext()` を呼ぶ |

両方を併用することも可能です（同じメッセージに `[Selected]` と `[ExposedContext]` の両ブロックが含まれます）。

---

---

## §10 アプリの無効化・削除

KovitoBoard では、不要になったアプリ（独自アプリ・レシピ由来アプリ問わず）をブラウザから整理できます。操作には性質の異なる 2 つがあります。**サンプルアプリを片付けたいだけなら、まず非破壊の「無効化」を案内してください。**

### 10.0 無効化（非破壊）と削除（破壊）の使い分け

| 操作 | 対象 | データ（`app/data/<appId>/`） | 復帰 | 操作場所 |
|---|---|---|---|---|
| **無効化（disable）** | 同梱サンプルアプリ | **保持される（非破壊）** | Sample apps タブから再有効化で復帰可能 | 「アプリ」画面 → **Sample apps タブ** |
| **削除（delete）** | 独自アプリ・レシピ由来アプリ全般 | エージェントが対話で確認のうえ削除 | 不可（再作成が必要） | アプリ画面の「アプリを削除」ボタン（§10.1〜） |

- **無効化:** 同梱サンプル（Document Viewer / TODO 等）を有効化したあと、Sample apps タブの操作で無効化できます。`app/<appId>/` のアーティファクトは取り除かれますが、`app/data/<appId>/` 配下の利用者データは**保持**されるため、再有効化で従来の状態に戻せます。「使わなくなったサンプルを一時的に片付けたい」用途に適します。
- **削除:** 独自に作り込んだアプリや、レシピ由来アプリを恒久的に消す操作です。エージェントとの対話でコードとデータを順に削除します（§10.1〜§10.7）。

> エージェントへの指針: 利用者が「サンプルアプリを消したい」と言った場合、データを失う完全削除の前に、まず非破壊の無効化（Sample apps タブ）で十分かを確認してください。

### 10.1 削除フロー（ユーザー視点）

1. 削除したいアプリの画面を開く（サイドバーから対象アプリを選択）
2. **サイドバー上部の「アプリを削除」ボタン**をクリック
3. 確認モーダルで内容を確認 → 「次へ」
4. **削除を依頼するエージェント**を選択（デフォルト: `kovito-developer`）→ 「削除を依頼」
5. エージェントとの対話セッションに自動遷移
6. エージェントが対話で削除作業を進める（次節 §10.2 参照）

### 10.2 エージェントが行う削除作業

エージェントは以下の手順で削除を進めます（KB は機械的削除をしません）:

#### Step 1: 状況確認

- `app/<appId>/` ディレクトリの存在確認
- `app/data/<appId>/` ディレクトリの存在確認
- `app/menu.ts` を Read してエントリ確認
- アプリが意図したものか、ファイル一覧をユーザーに提示して再確認

#### Step 2: 削除作業

ユーザーが OK を出したら順に削除:

| 削除対象 | 内容 |
|---|---|
| `app/menu.ts` の該当エントリ | サイドバーからアプリを消す |
| `app/<appId>/` ディレクトリ | アプリのコード一式（pages / api / styles / manifest 等） |
| `app/data/<appId>/` ディレクトリ | アプリ専用のデータ領域（`_audit.log` / `_kv.json` / 業務データ等）|

**`app/data/<appId>/` の削除前**には、エージェントが「業務データが含まれていないか」を再確認し、必要ならバックアップを提案します。

### 10.3 削除してはいけないもの

エージェントは以下を **絶対に削除しません**:

- `src/` 配下（KovitoBoard 本体コード）
- `.claude/` 配下（Claude Code 設定）
- `config/` 配下（KovitoBoard 設定）
- 他のアプリ（`app/<別 appId>/`）
- `recipes/` 配下（リポジトリ内サンプルレシピ）
- `recipes-installed/` 配下の **他 appId** のディレクトリ
- `recipe-history.json`（レシピのインストール履歴。アプリ削除では更新しません — §10.5 参照）

### 10.4 独自アプリのデータ領域（`.kovitoboard/<appId>/`）

長時間処理を伴う独自アプリ（§8 のパターン）では、運用データを `.kovitoboard/<appId>/` に保存している場合があります。エージェントはこのディレクトリも検出し、対話で削除可否を確認します。

### 10.5 レシピ由来アプリの場合の注意

レシピが作ったアプリを削除しても:

- **レシピのインストール履歴は更新されません**（`recipe-history.json` はそのまま）
- 同梱サンプル由来アプリは「アプリ」画面の **Sample apps タブ**で引き続き有効化候補として表示されます
- 同じサンプルを再度使いたい場合は、Sample apps タブの「**有効化**」から復帰できます（[`04-recipes.md`](./04-recipes.md) §3.3.1 / §5.3 参照）

なお外部レシピのインストール経路は v0.2.x では無効です（v0.3.0 で KovitoHub と連動して再開予定、[`04-recipes.md`](./04-recipes.md) §2）。

### 10.6 データ領域のクリーンアップ（任意）

レシピ由来アプリの場合、`recipes-installed/<appId>/manifest.json` という KovitoBoard 内部のメタデータファイルが残ります。アプリ自体は動かなくなるので残骸として残っても害は少ないですが、クリーンアップしたい場合はエージェントに依頼してください。

### 10.7 削除後の確認

- サイドバーからアプリが消える（`app/menu.ts` の変更を KovitoBoard が自動検出）
- ブラウザ上でアプリのページにアクセスしようとすると 404 になる
- `app/<appId>/` が存在しないことをファイラーで確認

### 10.8 エージェント向け Do / Don't チェックリスト（アプリ整理時）

アプリの無効化・削除をユーザーから頼まれたエージェントが従う集約チェックリストです。章をまたいで散在するルールをここに 1 枚にまとめます。

**Do（やること）:**

- ✅ **まず無効化で足りるか確認する。** サンプルアプリの片付けは非破壊の「無効化」（Sample apps タブ）を最優先で提案する（§10.0）。データを失う完全削除は、ユーザーが恒久削除を明確に望んだときだけ。
- ✅ **削除前に対象を読み上げて再確認する。** `app/<appId>/` と `app/data/<appId>/`、さらに長時間処理を伴う独自アプリ（§8）の場合は `.kovitoboard/<appId>/`（運用データ、§10.4）の中身（特に業務データ）をユーザーに提示し、消えるものを具体的に伝えてから進める（§10.2 Step 1）。**`.kovitoboard/<appId>/` の見落としに注意** — このチェックリストだけで判断せず、独自アプリでは §10.4 を必ず併せて確認する。
- ✅ **`app/data/<appId>/`（および独自アプリの `.kovitoboard/<appId>/`）の削除前にバックアップを提案する。** 業務データが含まれていれば、必要に応じて退避を案内する（§10.2 Step 2 / §10.4）。
- ✅ **削除は対話で 1 ステップずつ進める。** KB は機械的な一括削除をしない。エージェントが順に確認しながら消す。
- ✅ **レシピ由来アプリは Disable パスを使う。** 同梱サンプル／レシピ由来アプリは、破壊的な remove ではなく Disable（非破壊）に誘導する。再有効化でデータを引き継げる（§10.5、[`04-recipes.md`](./04-recipes.md) §5.3）。

**Don't（やってはいけないこと）:**

- ❌ **`src/` / `.claude/` / `config/` を削除しない。** KB 本体・Claude Code 設定・KB 設定はアプリ削除の対象外（§10.3）。
- ❌ **他アプリ（`app/<別 appId>/`）や他 appId の `recipes-installed/<別 appId>/` に触れない。** 削除対象は依頼された 1 アプリだけ（§10.3）。
- ❌ **`recipes/` 配下（同梱サンプルレシピの実体）を削除しない。** アプリを消してもサンプルレシピの実体は残す（Sample apps タブの再有効化候補として必要、§10.3 / §10.5）。
- ❌ **`recipe-history.json` をアプリ削除で書き換えない。** インストール履歴はアプリ削除では更新しない（§10.3 / §10.5）。
- ❌ **`.claude/CLAUDE.md` を勝手に書き換えない。** ユーザー領域。差分提示なしの編集は禁止（[`01-overview.md`](./01-overview.md) §5。なお `<project>/CLAUDE.md` への KB ガイダンス注入は別物 = §4.4）。
- ❌ **確認モーダルの ID 入力を代行して誤削除を誘発しない。** 削除確認は誤操作防止のためのもの。ユーザー自身に意思確認させる。
- ❌ **「動かないから」と残骸（`recipes-installed/<appId>/manifest.json` 等）を無断で消さない。** クリーンアップは任意で、ユーザー依頼があったときだけ（§10.6）。

> 起動・停止に関する Do / Don't（`pkill` / `kill -9` / `tmux kill-server` の禁止、KB 内部エージェントの自己停止禁止など）は [`11-lifecycle.md`](./11-lifecycle.md) を参照してください。

---

## 関連章

- レシピの詳細（宣言的 handler・scope） → [`04-recipes.md`](./04-recipes.md)
- サンプルレシピの再有効化 → [`04-recipes.md`](./04-recipes.md) §3.3.1
- **API ハンドラ・ページからログを出す方法 → [`08-logging.md`](./08-logging.md)（server: `globalThis.kbContext.logger` / renderer: `window.kb.log`）**
- `app/` が反映されない・API が呼ばれない → [`06-troubleshooting.md`](./06-troubleshooting.md)
- 高度なカスタマイズ → [`07-advanced.md`](./07-advanced.md)

---

## 11. 再起動時の capture state 永続化（v0.2.x）

**対象 KB バージョン:** v0.2.x 以降（spec `app-directory-extension.md` §10.5.6 連動）。

`window.kb.capture.<kind>`（a11y / exposed-context）を使うレシピは、React state その他のメモリ常駐 UI state を **再起動時の reload イベントで失われる前提** で扱う必要があります。KovitoBoard プロセスの再起動（SIGUSR2 / 終了して起動し直す）で per-launch internal token が無効化されると、host renderer は capture-token endpoint からの 401 を検知して in-flight な capture Promise をすべて `RestartReloadError` で reject、`window.location.reload()` を発火します。

### 推奨パターン: 永続化 + 再 hydrate

capture 処理は durable state から再開可能になるよう書きます:

```typescript
// capture を呼ぶ前に critical state を永続化する
async function capturePageA11y() {
  await window.kb.call('data:write', {
    path: '_state.json',
    content: JSON.stringify(currentState),
  })
  try {
    const snapshot = await window.kb.capture.a11y()
    return snapshot
  } catch (e) {
    if (e instanceof Error && e.name === 'RestartReloadError') {
      // KB がまもなく reload する。state は既に永続化済なので、
      // 再 mount 後に同じところから再開できる。silently return
      // して reload に任せる。
      return
    }
    throw e
  }
}

// 次回 mount 時に再 hydrate
useEffect(() => {
  async function rehydrate() {
    const persisted = await window.kb.call('data:read', { path: '_state.json' })
    if (persisted) setState(JSON.parse(persisted))
  }
  void rehydrate()
}, [])
```

### host が保証すること

- Pending な capture Promise は reload 発火 **前** に `RestartReloadError` で reject される
- reload は `setTimeout(..., 0)` でスケジュールされ、reject ハンドラが先に走る
- レシピ作者が手動で reload trigger を attach する必要はない — host が遷移を扱う

### 仮定してはいけないこと

- reload 後に React state が残ること（消える）
- 同じ `mountId` / capture token が reload 後に存在すること（どちらも mount ごとに fresh）
- scroll position / modal 開閉状態 / panel 展開状態（reload で全部消える）

v0.3.0 の isolation work で state preservation を見直し予定（Service Worker / out-of-process renderer ルートを設計中）。それまでは、server-side state から再構築できないものは必ず永続化してください。

