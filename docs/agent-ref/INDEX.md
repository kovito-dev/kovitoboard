# KovitoBoard 仕様リファレンス（エージェント用）

**対象 KB バージョン:** v0.1.0
**最終更新:** 2026-04-18

このドキュメントは、Kovito のコンシェルジュ「コビー」をはじめとするエージェントがユーザーの質問に答えるために参照する、KovitoBoard（以下 KB）仕様の目次です。

ユーザーが直接読んでも役立つよう書いていますが、エージェントが最短で必要な情報にたどり着くことを最優先の構造目的としています。

---

## 参照ルール（エージェント向け）

1. まずこの INDEX の「やりたいこと別ナビゲーション」で該当章を特定してください。
2. 該当章のファイルのみを Read してください（他の章は読まないでください）。
3. 複数章が該当する場合は、優先順位の高い順に 1 章ずつ読んでください。
4. **全章を一度に読むことは絶対にしないでください。**（コンテキスト圧迫防止）
5. 該当章を読んでもわからない場合、推測で答えず「わからないので、一緒に調べてみよう」とユーザーに伝えてください。

---

## やりたいこと別ナビゲーション

### 🔰 KB を初めて使う / 全体像を知りたい
→ [`01-overview.md`](./01-overview.md)

### 🤖 エージェントに関すること
- エージェントを追加したい → [`02-agents.md`](./02-agents.md) §3
- エージェントの名前・性格を変更したい → [`02-agents.md`](./02-agents.md) §4
- エージェントの画像を変えたい → [`02-agents.md`](./02-agents.md) §5
- エージェントが表示されない → [`06-troubleshooting.md`](./06-troubleshooting.md) §2

### 💬 セッション（エージェントとの会話）に関すること
- セッションを開始したい → [`03-sessions.md`](./03-sessions.md) §2
- 過去のセッション履歴を見たい → [`03-sessions.md`](./03-sessions.md) §4
- セッションが進まない → [`06-troubleshooting.md`](./06-troubleshooting.md) §3
- trust prompt（信頼確認）を求められた → [`06-troubleshooting.md`](./06-troubleshooting.md) §7

### 📦 レシピに関すること
- レシピとは何か → [`04-recipes.md`](./04-recipes.md) §1
- 外部レシピをインストールしたい → [`04-recipes.md`](./04-recipes.md) §2
- レシピの scope 承認を求められた → [`04-recipes.md`](./04-recipes.md) §7
- 自分で作ったものをレシピとして出力したい → [`04-recipes.md`](./04-recipes.md) §4
- 公式レシピを使いたい → [`04-recipes.md`](./04-recipes.md) §5
- レシピが読み込めない → [`06-troubleshooting.md`](./06-troubleshooting.md) §4

### 🛠️ 独自アプリ開発に関すること
- 自分だけのアプリを作りたい → [`05-apps.md`](./05-apps.md) §2
- app/ ディレクトリの構造 → [`05-apps.md`](./05-apps.md) §3
- 独自の API ハンドラを追加したい → [`05-apps.md`](./05-apps.md) §4
- ユーザー定義のバックエンド API とレシピの違い → [`05-apps.md`](./05-apps.md) §5

### ⚙️ 設定に関すること
- マスタ情報（ユーザー名等）を変更したい → [`01-overview.md`](./01-overview.md) §4
- プロジェクト名を変更したい → [`01-overview.md`](./01-overview.md) §4

### 🚨 トラブル対応
→ [`06-troubleshooting.md`](./06-troubleshooting.md)

### 🎓 もっと深く使いたい（上級）
→ [`07-advanced.md`](./07-advanced.md)

### 🔒 データ取扱いに関すること
- KB に読み込ませた情報はどこに渡るか → [`09-data-handling.md`](./09-data-handling.md) §1
- 機密情報を扱うアプリの設計指針 → [`09-data-handling.md`](./09-data-handling.md) §4
- マスキング実装の例 → [`09-data-handling.md`](./09-data-handling.md) §4
- AmbientSidebar に渡る情報 → [`09-data-handling.md`](./09-data-handling.md) §5

### ⬆️ KB をアップデートしたい
- バージョンアップが従来と違う理由 → [`10-upgrade.md`](./10-upgrade.md) §1
- アップデート前の準備（事前点検） → [`10-upgrade.md`](./10-upgrade.md) §2
- 標準のアップデート手順 → [`10-upgrade.md`](./10-upgrade.md) §3
- conflict が出た場合の対処 → [`10-upgrade.md`](./10-upgrade.md) §4
- アップデート後の動作確認 → [`10-upgrade.md`](./10-upgrade.md) §5
- 戻したい（rollback） → [`10-upgrade.md`](./10-upgrade.md) §6
- ユーザーエージェント向けプロトコル → [`10-upgrade.md`](./10-upgrade.md) §7
- バージョン警告が出ているとき → [`06-troubleshooting.md`](./06-troubleshooting.md) §8

---

## 章構成一覧

| ファイル | 内容 | 行数目安 |
|---------|------|---------|
| [`01-overview.md`](./01-overview.md) | KB の全体像・用語集・設定の基本 | 200 |
| [`02-agents.md`](./02-agents.md) | エージェントの追加・編集・画像設定 | 300 |
| [`03-sessions.md`](./03-sessions.md) | セッションの開始・操作・履歴 | 200 |
| [`04-recipes.md`](./04-recipes.md) | レシピ読込・実行・履歴・出力 | 400 |
| [`05-apps.md`](./05-apps.md) | app/ ディレクトリの使い方・独自アプリ開発 | 400 |
| [`06-troubleshooting.md`](./06-troubleshooting.md) | よくある問題と解決策 | 250 |
| [`07-advanced.md`](./07-advanced.md) | スキル・自動化・高度な設定 | 200 |
| [`09-data-handling.md`](./09-data-handling.md) | データ取扱いと注意事項（KB→Claude Code 経由のデータフロー、マスキング推奨） | 150 |
| [`10-upgrade.md`](./10-upgrade.md) | KB のバージョンアップ手順とユーザーエージェント向けプロトコル | 350 |

---

## 外部ドキュメント（このリファレンスの範囲外）

ユーザーから以下について尋ねられた場合、対応する URL またはファイルを案内してください:

- **KB の使い方ガイド（入門）:** リリース前は KB リポジトリの `README.md`（v0.1.0 時点）
- **レシピカタログ:** v0.1.0 では未公開。サンプルレシピは `04-recipes.md` §5 参照
- **ブログ・記事:** リリース後に公開予定（Kovito 公式）

---

## エージェント自身の振る舞いについて

- 回答前に必ずこの INDEX を読んでから該当章を参照してください。
- 該当章を読んでもわからない場合、推測で答えず「わからない」ことを正直に伝えてください。
- ユーザーの `.claude/` 配下や `CLAUDE.md` を勝手に編集しないでください（明示的な依頼があっても慎重に確認してください）。
- KB の仕様と実装が乖離している可能性がある場合、INDEX 最上部の「⚠️ 要更新」注記の有無を確認してください（現時点では記載なし）。
