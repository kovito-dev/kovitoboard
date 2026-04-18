# 05. 独自アプリ開発（`app/` ディレクトリ）

**対象 KB バージョン:** v0.1.0
**最終更新:** 2026-04-18

> 📖 **この章を読むタイミング:** INDEX.md の「自分だけのアプリを作りたい／app/ の構造／独自 API を追加したい」から誘導された場合。

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

---

## §1 `app/` ディレクトリとは

`app/` は **ユーザーが自由に拡張を追加できる専用領域** です。KB 本体（`src/`）とは物理的に分離されており、`git pull` で KB をアップデートしても衝突しません。

### 1.1 設計原則（DEC-004）

- **P1 コア不可侵:** ユーザーは `src/` 配下を変更せず、変更は `app/` に限定
- **P2 存在任意:** `app/` が無くても KB は完全動作（デフォルト UI）
- **P3 宣言的登録:** メニュー登録はハードコードではなく `app/menu.ts` で宣言
- **P4 標準技術:** Vite / Express の標準機能のみ（特殊な仕組み無し）

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

`app/api/` 配下の `.ts` / `.js` ファイルは、**サーバー起動時に自動で `/api/ext/{ファイル名}` にマウント** されます。

| ファイル | マウント先 |
|---|---|
| `app/api/my-data.ts` | `/api/ext/my-data` |
| `app/api/intel.ts` | `/api/ext/intel` |

制約:

- 1 階層のみ（サブディレクトリ非対応）
- 先頭が `_` のファイル（例: `_helpers.ts`）はスキップ
- 読み込みは **起動時 1 回**。BE の変更は再起動必須

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
- `app/api/*.ts`（ユーザー定義のバックエンド API）は **そのままではエクスポート不可**
  - 必要な BE 機能が Category A handler（§6.2 参照 in `04-recipes.md`）で表現できれば、レシピ化時に宣言的 handler に書き換えて書き出せる
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

## 関連章

- レシピの詳細（宣言的 handler・scope） → [`04-recipes.md`](./04-recipes.md)
- `app/` が反映されない・API が呼ばれない → [`06-troubleshooting.md`](./06-troubleshooting.md)
- 高度なカスタマイズ → [`07-advanced.md`](./07-advanced.md)
