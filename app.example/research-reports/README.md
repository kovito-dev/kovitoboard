# Research Reports — 参考実装

このディレクトリは「長時間処理を伴う BE 付きアプリ」の参考実装です。`docs/agent-ref/05-apps.md` §8 のパターンをそのまま具体化しています。

## 何ができるか

- 調査したいテーマを入力すると、Claude Code が Web 検索で情報を集めます
- 結果を Markdown レポートとして保存します（本文・出典一覧付き）
- レポートを一覧表示し、選択すると整形表示します
- 調査中はポーリングでステータスが更新されます（`queued → running → completed | failed`）

## 使い方

### このディレクトリをコピーして自分の `app/` に配置

```bash
cp -r app.example/research-reports app/research-reports
```

配置後、KB サーバーを再起動してください（BE API の自動マウントは起動時 1 回のみ実行されます）。

- サーバー再起動後、サイドバーに「Research Reports」が追加されます
- 画面でテーマを入力 → 「調査開始」クリック → 数分後にレポートが一覧に追加されます
- レポートをクリックすると本文が表示されます

## アーキテクチャ

- フロントエンド: `page.tsx`（React）
- バックエンド（ユーザー定義 BE API、`/api/ext/research-reports/*` にマウント）:
  - `api/start-research.ts` — ジョブ起動。`jobId` を返す
  - `api/status.ts` — ポーリング用ステータス取得
  - `api/list-reports.ts` — 生成済みレポート一覧取得
  - `api/get-report.ts` — 個別レポート取得
- 調査エージェント: `prompts/research-agent.md`（tmux サブセッションで起動されるシステムプロンプト）
- データ: `.kovitoboard/research-reports/` 配下に保存

## データフロー

```
ユーザーがテーマ入力
   ↓
page.tsx → POST /api/ext/research-reports/start-research
   ↓
start-research.ts
   ├── .kovitoboard/research-reports/jobs.jsonl に 1 行追記
   ├── .kovitoboard/research-reports/{jobId}/ を作成
   └── tmux サブセッションを起動（prompts/research-agent.md を渡す）
   ↓ （即座に jobId を返す）
page.tsx がポーリング開始（10 秒間隔）
   ↓
サブセッションが Claude Code 上で WebFetch を呼び出し、
.kovitoboard/research-reports/{jobId}/ に成果物を保存
   ├── report.md      ← 本文
   ├── sources.json   ← 参照 URL
   └── status.json    ← { status, startedAt, finishedAt, error? }
   ↓
status.json が "completed" に更新されたら
page.tsx がポーリングを停止し、get-report で本文を取得して表示
```

## カスタマイズポイント

- **調査プロンプト**: `prompts/research-agent.md` を編集すると、調査の進め方・出力フォーマット・制約を変更できます
- **ポーリング間隔**: `page.tsx` 冒頭の `POLL_INTERVAL_MS` 定数（既定 10 秒）
- **レポート保存先**: `.kovitoboard/research-reports/` を別パスに変える場合、4 本の API ファイルすべてを同期して編集してください
- **同時実行ジョブ数**: `start-research.ts` の先頭で制御（既定 3 件、超過時は `queued` ステータスで待機）

## 制約事項

- **Web 検索は Claude Code の WebFetch 経由**（URL 指定取得のみ、全文検索エンジンは使えません）
- **同時実行ジョブ数の上限は 3 件**（FIFO、超過分は `queued` ステータスで待機）
- **1 レポートあたりの最大サイズは 1 MB**（`report.md` がこれを超えると `failed` で終了）
- **実行時間の上限は 30 分**（超過時は途中結果を保存して `failed`）

## 関連ドキュメント

- 標準パターン解説: [`../../docs/agent-ref/05-apps.md`](../../docs/agent-ref/05-apps.md) §8
- 一次仕様: [`../../docs/specs/v0.1.0-onboarding-scenarios.md`](../../docs/specs/v0.1.0-onboarding-scenarios.md) §4.11
- 実現計画: [`../../docs/design/v0.1.0-research-reports-plan.md`](../../docs/design/v0.1.0-research-reports-plan.md)
