# 08. ロギング規約

**対象 KB バージョン:** v0.2.12
**最終更新:** 2026-06-20

> 📖 **この章を読むタイミング:** INDEX.md の「アプリ・レシピを書く時のログ規約」から誘導された場合、または `04-recipes.md` / `05-apps.md` から「ロギングは §8 を参照」のリンクで誘導された場合。

---

## この章の目的

KB 上でユーザーが書く拡張コード（アプリの API ハンドラ、レシピのページ）からのログ出力を、KB 本体と同じ機構・規約に従って実装する方法を示します。

これにより:

- ユーザー環境のエージェント（Kovito 開発者・コビーなど）が `.kovitoboard/logs/server.log` 一本で**ユーザー拡張の挙動も含めて**診断できる
- 不具合報告時に該当機能のログが自動収集される
- 規約に従わない実装（生 `console.*`）はログファイルに残らないため、エージェント診断が効かなくなる

## 目次

- §1 KB のログ機構の概要
- §2 component 命名規約（3 系統）
- §3 server 側 API ハンドラでのログ出力
- §4 renderer 側 recipe ページでのログ出力
- §5 ログレベルの使い分け
- §6 PII / 機密情報の扱い
- §7 サンプル実装
- §8 トラブル時の参照誘導

---

## §1 KB のログ機構の概要

### 1.1 ログの出力先

| 出力先 | 形式 | 用途 |
|---|---|---|
| `.kovitoboard/logs/server.log` | JSON Lines | エージェント解析・事後参照（メイン） |
| `.kovitoboard/logs/server-YYYY-MM-DD.log` | JSON Lines | 過去日のログ（デフォルト 7 日保持） |
| ターミナル stdout | JSON Lines | プロセス起動時の即時把握 |
| ブラウザ DevTools console | 整形済み（人間視認） | 開発時のフォールバック |

### 1.2 1 行のレコード例

```json
{"ts":"2026-04-25T12:34:56.789Z","level":"info","component":"app.research-reports","msg":"Research started","data":{"jobId":"job-abc","theme":"AI agents"},"pid":12345}
```

エージェントは `jq` 等で component / level / data フィールドを抽出して診断する。

### 1.3 KB 本体ログとの統合

ユーザー拡張のログも、KB 本体のログ（`server`, `tmux-bridge`, `client.useIPC` 等）と同じファイルに**時系列で混在**する。これにより 1 ファイルを追うだけで原因と影響範囲を追跡できる。

---

## §2 component 命名規約（3 系統）

KB 全体のログは component 名で 3 系統に区別される:

| prefix | 用途 | 例 |
|---|---|---|
| **無 prefix** | KB 内部 server | `server`, `tmux-bridge`, `trust-prompt`, `watcher`, `recipe-loader`, `startup`, `api`, `ws`, `admin`, `auto-tmux` |
| **`client.*`** | KB 内部 renderer | `client.useIPC`, `client.app-loader`, `client.injectKb`, `client.MessageInput`, `client.error-boundary`, `client.global-errors` |
| **`app.<name>.*`** | ユーザー拡張（アプリ・レシピ） | `app.research-reports`, `app.todo`, `app.document-viewer`, `app.<recipeId>` |

**ユーザーが書くコードは `app.*` に該当**します。`app.` prefix は KB が自動で付与するため、**ユーザーは prefix なしの component 名（例: `research-reports`）を指定するだけ**で済みます。

### 2.1 component 名の選び方

- **アプリ単位 / レシピ単位で 1 つ**（例: `research-reports`, `todo`, `document-viewer`）
- ファイル単位ではなく機能単位（`get-report` のような細かい分割は推奨しない）
- 1〜64 文字、半角英数字とハイフン推奨
- KB 本体の component 名（`server`, `tmux-bridge` 等）と重複させない

### 2.2 ログ抽出例

エージェントが診断時に:

```bash
# ユーザー拡張のログだけ抽出
grep '"component":"app\.' .kovitoboard/logs/server.log

# 特定アプリのログのみ
grep '"component":"app.research-reports"' .kovitoboard/logs/server.log

# error レベルのユーザー拡張ログのみ
grep '"component":"app\.' .kovitoboard/logs/server.log | grep '"level":"error"'
```

---

## §3 server 側 API ハンドラでのログ出力

### 3.1 利用方法

server 側の handler（`app/api/<name>.ts` や `app/<name>/api/*.ts` の Express Router）からは `globalThis.kbContext.logger('<component>')` で logger を取得します。

```ts
// app/api/example.ts（または app/<name>/api/<file>.ts）
import { Router } from 'express'

// ファイル先頭で 1 度だけ logger を取得
const log = (globalThis as any).kbContext.logger('example')
// ↑ component name は 'app.example' として server.log に記録される

const router = Router()

router.get('/', (req, res) => {
  log.info({ url: req.url }, 'GET /')
  res.json({ message: 'Hello' })
})

router.post('/items', async (req, res) => {
  try {
    const result = await createItem(req.body)
    log.info({ itemId: result.id }, 'Item created')
    res.json(result)
  } catch (err) {
    log.error({ err, body: req.body }, 'Failed to create item')
    res.status(500).json({ error: 'internal' })
  }
})

export default router
```

### 3.2 呼び出し規約

```ts
log.<level>(msgOrData, msg?)
```

| level | 第一引数: string（msg のみ） | 第一引数: object（data） + 第二引数: string（msg） |
|---|---|---|
| `log.info('Started')` | ✅ | — |
| `log.info({ jobId: 'abc' }, 'Job started')` | — | ✅ |
| `log.error({ err }, 'Failed')` | — | ✅ |

**`{ err }` は推奨パターン** — Error オブジェクトを pino が自動で展開し、`message` / `stack` / `name` を構造化記録する。

### 3.3 やってはいけないこと

```ts
// ❌ 文字列結合で値を埋め込む（構造化されない）
log.info(`Job ${jobId} started`)

// ✅ data フィールドに分離する
log.info({ jobId }, 'Job started')

// ❌ Error オブジェクトを文字列化する
log.error(`Error: ${err.message}`)

// ✅ Error をそのまま渡す（stack も自動取得）
log.error({ err }, 'Failed')

// ❌ 機密情報を data に含める
log.info({ apiKey: process.env.OPENAI_API_KEY }, 'Calling API')

// ✅ メタ情報のみ
log.info({ provider: 'openai' }, 'Calling API')
```

---

## §4 renderer 側 recipe ページでのログ出力

### 4.1 利用方法

レシピのページ（`app/<recipeId>/page.tsx`）からは `window.kb.log` で logger を呼びます。

```tsx
// app/research-reports/page.tsx
function ReportsPage() {
  const handleStart = async (theme: string) => {
    window.kb.log.info({ theme }, 'Starting research')

    const result = await window.kb.call('start-research', { theme })

    if (result.ok) {
      window.kb.log.info({ jobId: result.data.jobId }, 'Research started')
    } else {
      window.kb.log.error({ err: result.error }, 'Failed to start research')
    }
  }

  return <button onClick={() => handleStart('AI agents')}>Start</button>
}
```

### 4.2 component 名は自動設定

`window.kb.log` の component 名は KB が自動で `app.<recipeId>` に設定します。**ユーザーは component 名を意識しなくて済みます**。

### 4.3 呼び出し規約

§3.2 の server 側と同じ規約です（`window.kb.log.info(data?, msg)`）。

### 4.4 動作の仕組み

1. ユーザーが `window.kb.log.info(...)` を呼ぶ
2. KB の renderer logger ヘルパーが ① ブラウザ DevTools console に整形出力（フォールバック）、② WebSocket で server に送信
3. server 側で `client_log` イベントとして受信、`childLogger('app.<recipeId>')` で pino に流し込み
4. `.kovitoboard/logs/server.log` に JSON Lines として記録

WebSocket 切断中は queue に積まれ、再接続時に flush されます。

---

## §5 ログレベルの使い分け

| level | 使うべき場面 | 例 |
|---|---|---|
| `debug` | 開発時のみ参照する詳細トレース。本番で常時出すと冗長 | `log.debug({ payload }, 'Processing request')` |
| `info` | 通常の動作記録（処理開始・完了・状態遷移） | `log.info({ jobId }, 'Job started')` |
| `warn` | 想定内の異常（リトライ可能・処理は継続） | `log.warn({ retries }, 'API rate-limited, retrying')` |
| `error` | 想定外の異常（処理が失敗、復旧策が必要） | `log.error({ err }, 'Failed to save')` |

**`fatal`** は KB 本体の global error handler 専用で、ユーザー拡張からは使いません。

### 5.1 判断のヒント

- 「これはエラー？それとも警告？」の判定:
  - 処理が**続行できる** + リトライで解決し得る → `warn`
  - 処理が**失敗** + ユーザー操作なしには復旧不能 → `error`
- 「これは debug？info？」の判定:
  - **本番でも残したい** → `info`
  - **開発時に詳細を追うため** → `debug`

---

## §6 PII / 機密情報の扱い

### 6.1 自動でマスクされるもの

KB のロガーは以下を**自動でマスク**します:

- ホームディレクトリパス（`/home/<user>/...` → `~/...`）
- Windows のユーザーパス（`C:\Users\<user>\...` → `~\...`）

### 6.2 ユーザー責任で**含めない**べきもの

以下はユーザーが意識して除外してください（v0.1.0 では自動マスクなし）:

- API キー（`sk-ant-*`, `sk-*`, OAuth トークン等）
- パスワード・認証トークン
- ファイル内容そのもの（メタデータ程度に留める）
- メールアドレス（v0.2.x で自動マスク予定）
- 個人を特定できる情報（氏名・住所・電話番号 等）

### 6.3 不安なときのテクニック

```ts
// ❌ 全文を含める
log.info({ content: fileContent }, 'File loaded')

// ✅ メタ情報のみ
log.info({ size: fileContent.length, lines: fileContent.split('\n').length }, 'File loaded')

// ❌ オブジェクト全体
log.info({ user }, 'Authenticated')

// ✅ 必要な ID のみ
log.info({ userId: user.id }, 'Authenticated')
```

### 6.4 Issue 添付前の確認

`npm run diagnose > diag.md` で生成した診断レポートを GitHub Issue に貼る前に、**必ず内容を目視確認**してください。自動マスクで除去できなかった機密が混入していないか確認する責任はユーザー側にあります。

---

## §7 サンプル実装

### 7.1 server 側ハンドラの参考実装

`app.example/research-reports/api/` 配下のサンプル群が `globalThis.kbContext.logger('research-reports')` 経由でログを出力する**参考実装**です。

該当ファイル:

- `app.example/research-reports/api/list-reports.ts`
- `app.example/research-reports/api/get-report.ts`
- `app.example/research-reports/api/start-research.ts`
- `app.example/research-reports/api/status.ts`

新規にレシピやアプリを書くときは、これらをテンプレートとして参考にしてください。

### 7.2 typescript の型補完

`window.kb.log` は `KbLogger` 型として型定義されているため、TypeScript で記述する際に IDE の補完が効きます:

```ts
window.kb.log.  // ← debug / info / warn / error の候補が出る
```

---

## §8 トラブル時の参照誘導

ログ確認・診断レポート生成・GitHub Issue 報告の手順は [`06-troubleshooting.md`](./06-troubleshooting.md) §8 を参照してください。

エージェント（Kovito 開発者など）に相談する際、`.kovitoboard/logs/server.log` の直近内容を Read してもらえば、`app.<name>.*` 系のログから問題を特定できます。

---

## 関連章

- アプリ追加開発 → [`05-apps.md`](./05-apps.md)
- レシピシステム → [`04-recipes.md`](./04-recipes.md)
- トラブルシュート・ログ参照 → [`06-troubleshooting.md`](./06-troubleshooting.md)
