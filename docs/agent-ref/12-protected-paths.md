# 12. 保護対象パス（直接編集禁止）

**対象 KB バージョン:** v0.2.4
**最終更新:** 2026-06-11

> 📖 **この章を読むタイミング:** あらゆるエージェント（Claude Code の general-purpose エージェントのような非 KB エージェントを含む）がファイルを編集する・コマンドを実行する・KB のランタイム状態と対話する前に。`<projectRoot>/.kovitoboard/`・`<projectRoot>/.claude/`・組み込み KB のインストールディレクトリ・KB の tmux セッション配下のものは保護対象である可能性があります。まずこの章を参照してください。

---

## この章の目的

KovitoBoard は、エージェントが直接編集してはならない一連のファイル・ランタイム状態・外部前提を管理します。直接編集はデータ損失・ランタイム破損・サイレント障害・セキュリティ境界の侵害を引き起こす可能性があります。

この章では、保護対象パスごとに (a) 管理者、(b) 直接編集が禁止される理由、(c) 代わりに使うべき適切な API/UI/CLI 経路を列挙します。迷ったら、`<projectRoot>/.kovitoboard/`・`<projectRoot>/.claude/`・KB のインストールディレクトリ配下の何かを編集する前にこの章を参照してください。

## 目次

- §1 KB に保護対象パスがある理由
- §2 KB が管理するファイル（直接編集禁止）
- §3 KB が依存する外部前提
- §4 KB 動作中のランタイム状態
- §5 ユーザーカスタマイズ・レシピ・アプリ
- §6 セキュリティ境界
- §7 代替経路のまとめ

## パスのプレースホルダ

以下の表全体で、次のプレースホルダを一貫して使います:

- **`<projectRoot>`** — ユーザーのプロジェクトルート（KB を起動したディレクトリ。`.kovitoboard/` と `.claude/` が存在する場所）。
- **`<kbRepo>`** — 組み込み KB のインストールディレクトリ（OSS 配布物の checkout。embedded レイアウトでは通常 `<projectRoot>/kovitoboard/`）。

エージェント向けの信頼境界の注記: KB 内部向けの編集は `<kbRepo>` に属し（ほぼ常に、まず仕様改訂が必要）、ユーザーのデータ向けの編集は `<projectRoot>` に属する（下記の代替経路に従う）。

---

## §1 KB に保護対象パスがある理由

KB はユーザーに代わってファイル・ランタイム状態・外部前提を管理します。エージェントがこれらのいずれかを直接編集すると:

- **データ損失** — アトミック書き込みの競合状態が JSON ストアを破損させ、追記専用ログが順序保証を失い、レシピ履歴がインストール済み manifest との整合性を壊す。
- **ランタイム破損** — tmux のウィンドウ命名規約が壊れ、スーパーバイザの PID ファイルが「stale なのに新鮮だと信じられる」状態になり、次回起動時に `app/` symlink が別の場所を指す。
- **サイレント障害** — `current.log` が通常ファイルに置き換わると pino-roll のログローテーションが止まる。信頼確認（trust prompt）の検出パターンがキャプチャ済み証跡を失う。`_audit.log` が処理途中で truncate されるとローテーションが壊れる。
- **セキュリティ境界の侵害** — 信頼確認 UI をバイパスするとユーザー同意モデルが壊れる。CSP や scope 検証を緩めるとクロスオリジン / クロススコープのリスクが再び開く。デフォルトで秘匿されるフィールドをログ出力すると秘密情報が漏れる。

この章は、KB 同梱エージェント（コンシェルジュ「コビー」/ KB 開発者 / 秘書）と、KB プロジェクト内部で起動されるあらゆる非 KB エージェントが、列挙されたパスに触れる前に参照すべき SSOT です。同じ内容が KB の内部仕様からミラーされており、同梱エージェントと外部コントリビューターの双方が単一の理解を共有できるようにしています。

---

## §2 KB が管理するファイル（直接編集禁止）

| パス | 管理者 | 直接編集が禁止される理由 | 代替経路 |
|---|---|---|---|
| `.kovitoboard/setting.json` | `setting-manager.ts`（アトミック書き込み） | パースエラー / 書き込み競合 / ユーザー設定の喪失 (A-1) | KB UI の設定ページ、または `setupOnboarding` API |
| `.kovitoboard/session-agents.jsonl` | `session-manager.ts`（追記専用） | 追記専用の不変条件が壊れ、履歴の整合性が失われる (A-2) | Session API（`/api/session/*`） |
| `.kovitoboard/recipe-history.jsonl` | `recipe-applicator.ts`（追記専用） | 追記専用の不変条件が壊れ、履歴の整合性が失われる (A-2) | Recipe API（`/api/recipes/*`） |
| `.kovitoboard/recipes-installed/<appId>/manifest.json` | `recipe-applicator.ts` | manifest と `recipe-history.jsonl` の間にドリフトが生じる (A-3) | レシピのインストール / アンインストール API |
| `.kovitoboard/logs/`（`current.log` symlink を含む） | pino-roll（KB 内部ロガー） | ローテーションの不変条件が壊れ、ログが診断不能になる (A-4) | エージェントは読み取り専用。クリーンアップは（KB を停止した状態で）ユーザーが行う保守作業。エージェントはこれらのファイルを truncate・リダイレクト・削除してはならない。 |
| `.kovitoboard/debug/trust-prompt/<file>` | `trust-prompt-relay.ts` | 検出パターンの改善に使うキャプチャ済み証跡が失われる (A-5) | エージェントは読み取り専用。確認済みパターンのキャプチャのクリーンアップはユーザーが行う保守作業。エージェントはエントリを削除してはならない。 |
| `.kovitoboard/run/supervisor.pid` | `kb-start.mjs` | stale 検出ロジックが混乱し、多重インスタンスの協調が壊れる (C-1) | 通常運用では `npm run kb:stop`（書き込み / 削除はスーパーバイザ / kb-stop が所有）。**唯一の例外（PID reuse からの復旧）:** ファイル内の pid が **生存しているが KB と無関係なプロセス**を指していると検証できた場合（`ps -p <pid> -o command=` で確認。OS が元のスーパーバイザ死亡後に同じ pid を再利用したケース、`11-lifecycle.md` §2 参照）に限る。このとき (a) `kb:stop` はその pid に SIGTERM を送るため無関係なプロセスを kill しうる、(b) `kb-start` は pid が生存しているのを見て「起動済み」と誤認し終了コード 1 で拒否する — どちらの公式経路でも復旧できない。この場合に限り、**当該 PID ファイル 1 つだけ**を削除し（前提: pid が KB でないと検証済み + KB スーパーバイザが実際には動いていない）、その後 §2 の手順で起動し直してよい。これ以外の目的での手編集・手削除（例: 「再起動を強制する」ための削除、`11-lifecycle.md` §3 参照）は引き続き禁止。 |
| `<kbRepo>/app`（`<projectRoot>/app` を指す symlink） | `kb-start.mjs`（`ensureAppSymlink`） | 次回起動時に symlink セットアップ警告が出て、ユーザーのアプリが消える (A-6) | KB が管理（symlink を変更する必要がある場合はスーパーバイザを再起動） |
| `<kbRepo>/dist/`（本番ビルド成果物） | `npm run build` | tree を手で編集するとローダーのパスが混乱する | `npm run build` でのみ生成 |

---

## §3 KB が依存する外部前提

| パス / 対象 | 管理者 | 直接編集が禁止される理由 | 代替経路 |
|---|---|---|---|
| `<projectRoot>/.claude/agents/<id>.md` | ユーザー / Claude Code | フロントマター（`name` / `description` / `model`）を KB が読む。規約を壊すとエージェント一覧と ID 解決が壊れる (B-1) | これらはユーザー所有のファイル。エージェントはユーザーの明示的な承認なしに変更してはならない。ユーザーが編集を依頼した場合は、Claude Code 公式のフロントマター規約を保持する。 |
| `<projectRoot>/CLAUDE.md` の `<!-- KB:GUIDANCE_START --> ... <!-- KB:GUIDANCE_END -->` ブロック | KB（CLAUDE.md ガイダンス注入） | ブロック内の手編集は次回起動時に上書きされる（冪等な再注入）。`claudeMdGuidance.disabled` のオプトアウトを参照 (B-2) | オプトアウトはユーザー設定。ガイダンス注入を無効化するには KB の設定 UI を使う。そのフローはサポートされた writer を通じて `setting.json` を更新する。エージェントはこのフラグを切り替えるために `setting.json` を直接編集してはならない。 |
| Claude Code バイナリ（`~/.claude-versions/<ver>/bin/claude`） | ユーザー + KB のバージョン検出 | `@latest` / `@beta` に切り替えると信頼確認（trust prompt）の検出パターンが壊れる可能性がある (B-3) | KB が表示するバージョン互換性の警告に従う |
| `<projectRoot>/.gitignore` の `kovitoboard/` エントリ | ユーザー | エントリが無いと組み込み KB のインストールがユーザーのリポジトリに漏れ、履歴が肥大化する (B-4) | 初期セットアップガイドとオンボーディングチェック（堅牢化されたチェックは v0.3.x ロードマップ上） |
| `<kbRepo>/templates/agents/<name>.md` | OSS 配布物（git 管理） | 編集が KB アップデートと衝突し、カスタマイズが失われる (B-5) | まず `<projectRoot>/.claude/agents/<id>.md` にコピーしてからカスタマイズする |

---

## §4 KB 動作中のランタイム状態

| 対象 | 管理者 | 直接編集が禁止される理由 | 代替経路 |
|---|---|---|---|
| tmux セッション `kovitoboard-<projectDir>` | `tmux-bridge.ts` | ウィンドウ命名規約が壊れ、`AgentActivityMonitor` の状態が破損する (C-1) | KB UI（エージェントの起動 / 停止）または `npm run kb:stop` |
| ポート 3001（バックエンド）/ 5173（Vite）（デフォルト） | `kb-start.mjs` のポート解決 | `lsof -i :3001 → kill -9` は別の KB インスタンスを停止してしまう可能性がある (C-2) | `npm run kb:stop`（スーパーバイザの PID ファイルを使う） |
| 内部 API `/api/admin/*`（再起動 / 停止） | `admin-routes.ts` | 再起動ループで Claude プロセスが蓄積する (C-3) | エージェントは KB UI のボタンのみ。これらのエンドポイントへの生の HTTP 呼び出しは、（明示的なセーフガードを伴う）人間の管理者による復旧手順のために予約されており、エージェントの自動化には適さない。 |
| WebSocket `/api/ws` の信頼確認応答（trust-prompt-response）経路 | `trust-prompt-relay.ts` | ユーザー同意フローがバイパスされ、信頼モデルが崩壊する (C-4) | KB UI の信頼確認（trust prompt）承認フローのみ |
| KB 起動時の `KOVITOBOARD_PROJECT_ROOT` env | ユーザー + `config.ts` の優先順位チェーン | 共有インストール由来のパス問題 (C-5) | embedded model: `npm start -- --project-root ..` で起動する（M-1 が KB clone 自体の内部からの起動を拒否する） |

---

## §5 ユーザーカスタマイズ・レシピ・アプリ

| パス | 管理者 | 直接編集が禁止される理由 | 代替経路 |
|---|---|---|---|
| `app/<appId>/manifest.json` | KB（`recipe-applicator.ts`） | `appId` の衝突。レシピ出力の整合性が壊れる (D-1) | Recipe API または KB UI のレシピ出力機能 |
| `app/<appId>/api/*.ts`（宣言的ハンドラ部） | ユーザー作成 + KB スキャナ | 自由形式の Express スタイルはロード時スキャンに失敗し、ハンドラのディスパッチが壊れる (D-2) | KB の app-directory-extension 仕様にあるハンドラ規約に従う |
| `app/data/<appId>/_audit.log`（ローテーション含む） | KB の監査ログサブシステム | ローテーションの不変条件が壊れ、監査証跡が失われる (D-3) | エージェントは読み取り専用（ローテーションは KB が所有。エージェントはファイルを truncate・手動ローテーションしてはならない）。 |
| レシピの scope 承認状態（`recipe-history.jsonl` の `scope` フィールド） | KB の scope 検証パイプライン | 配布時のセキュリティ前提が崩壊する (D-4) | レシピのインストール UI / API のみ |

---

## §6 セキュリティ境界

| 対象 | 管理者 | 直接編集が禁止される理由 | 代替経路 |
|---|---|---|---|
| `<kbRepo>/src/server/**` の CSP / scope 検証コード | OSS メンテナ + 既存仕様 | クロススコープのリスクが再び開く (E-1) | 編集する前に KB の design-review プロセスを通じて仕様改訂を起票する |
| `<kbRepo>/src/server/trust-prompt-relay.ts` の検出 / 応答経路 | OSS メンテナ | 自動応答ラッパーは信頼モデルを崩壊させる (E-2) | ユーザー同意は UI を通じてのみ受け付ける |
| `setting.json` のデフォルトで秘匿されるフィールド（現在および将来） | `setting-manager.ts` | 生の値をログ出力するデバッグコードを追加すると秘密情報が漏れる (E-3) | KB の logging 仕様にあるマスキング規約に従う（v1.0 時点では秘匿フィールドは未定義） |

---

## §7 代替経路のまとめ

エージェントが試みがちな編集を対象にした「代わりにこうする」早見表です。

| やりたいこと | 使うもの | やってはいけないこと |
|---|---|---|
| 設定（locale、displayName 等）を変更する | KB UI の設定ページ | `.kovitoboard/setting.json` を直接編集する |
| レシピをインストール / アンインストールする | KB UI のレシピページまたは `/api/recipes/*` | `recipes-installed/<appId>/manifest.json` を変更する |
| KB をクリーンに停止する | `npm run kb:stop` | スーパーバイザの PID を `kill -9` する |
| PID reuse から復旧する（生存中の pid が KB でないと検証済み） | §2 の唯一の例外に従い、当該 PID ファイル 1 つだけを削除して再起動する | 検証なしに `supervisor.pid` を削除する／「再起動を強制する」ために削除する |
| KB のログを確認する | `.kovitoboard/logs/current.log` を読む | ファイルを truncate / リダイレクトする |
| `<kbRepo>/app` の symlink を調整する | スーパーバイザを再起動する | symlink を `rm` して手動で作り直す |
| 同梱エージェントテンプレートを編集する | `<projectRoot>/.claude/agents/<id>.md` にコピーしてからそこで編集する | `<kbRepo>/templates/agents/<name>.md` を直接編集する |
| Claude Code のバージョンを固定する | KB が提供するバージョン制御を使う（少なくとも KB の互換性警告を尊重する） | 検出パターンを確認せずにバイナリを `@latest` / `@beta` に切り替える |
| 同じプロジェクトで複数の KB インスタンスを動かす | プロジェクトルートごとに 1 つのスーパーバイザ（M-1 が共有インストールの起動を拒否する） | 同じプロジェクトに対して別のシェルで 2 つ目の `npm start` を起動する |
| 信頼確認（trust prompt）を承認する | KB UI の信頼確認ダイアログ | `/api/ws` に WebSocket フレームを直接送る |
| 独自の API ハンドラを追加する | ハンドラ規約に従って `app/<appId>/api/*.ts` 配下に置く | 自由形式の Express ルーターを KB にマウントする |
| `_audit.log` を確認・ローテーションする | KB が管理するローテーションのみ | ファイルを truncate・手動ローテーションする |
| CLAUDE.md ガイダンスブロックを無効化する | KB の設定 UI からガイダンス注入を無効化する（サポートされた writer が `setting.json` を更新する） | `.kovitoboard/setting.json` を直接編集する、または `<!-- KB:GUIDANCE_START -->` の内部を手編集する（再注入される） |

---

## 関連する章

- エージェント → [`./02-agents.md`](./02-agents.md)
- レシピ → [`./04-recipes.md`](./04-recipes.md)
- アプリ → [`./05-apps.md`](./05-apps.md)
- トラブルシューティング → [`./06-troubleshooting.md`](./06-troubleshooting.md)
- データ取扱い → [`./09-data-handling.md`](./09-data-handling.md)
- KB のバージョンアップ → [`./10-upgrade.md`](./10-upgrade.md)
