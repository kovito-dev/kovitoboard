[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

# 変更履歴

KovitoBoard の主要な変更点を本ファイルに記録します。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### 修正

- プロジェクトの `app/menu.ts` がメニュー配列を型注釈なし
  （`export const menuEntries: AppMenuEntry[] = [...]` ではなく
  `export const menuEntries = [...]`）で宣言している場合に、同梱サンプル
  アプリの有効化・無効化が失敗しなくなりました。メニューエディタが
  両方の形式を受け付けるようになっています。
- 信頼性確認・未知プロンプトのダイアログで、実メッセージを折りたたみ
  アコーディオンに隠さず常に表示するようになりました。あわせて、サー
  フェス背景（ライトモードでは白）と高いコントラストの文字色で表示し、
  読みやすくなっています。

## [0.2.9] - 2026-06-16

### 追加

- README にプロジェクトのステータス節を追加し、KovitoBoard が早期開発段階
  （Pre-1.0）であることを明示しました。機能がまだ足りない部分があること、1.0
  までは破壊的変更が入りうること（変更点は本 CHANGELOG に記載）、大切なデータの
  バックアップを推奨すること、GitHub Issue でのフィードバックを歓迎することを
  案内しています。

## [0.2.8] - 2026-06-15

### 修正

- アプリの起動中に出現したセッションファイルを復旧できるようになりました。
  以前は、起動処理中の限られたタイミングで新しいセッションのログファイルが
  作成されると、バックエンドがファイル作成イベントを取りこぼし、次回の
  再起動までそのセッションが UI に表示されないことがありました。今後は
  バックエンドがセッションディレクトリを照合し、これらのセッションを確実に
  拾い上げます。
- ライトモードで警告・ステータスのテキストが読みやすくなりました。「更新が
  利用可能」のヘッダーバッジを含むいくつかの警告メッセージが、ダークモード
  向けにのみ調整された色を使っていたため、明るい背景では読みづらい状態でした。
  今後はテーマの警告用カラートークンを使用し、ライト・ダーク両方のテーマに
  適応します。

## [0.2.7] - 2026-06-15

### セキュリティ

- 開発時依存の `esbuild` を 0.28.1 以降（`tsx` 4.22.0 経由）へ更新し、
  ローカル開発サーバーにのみ影響する 2 件のアドバイザリを解消しました。
  配布されるアプリケーションのランタイムが影響を受けることはありません。

### 変更

- 破損した、または読み取れない supervisor の PID ファイルを、起動時に
  自動で上書きしなくなりました。代わりに、壊れた PID ファイルのパスと
  削除方法を示す明確なエラーを表示して停止し、2 本目の supervisor が
  気づかぬうちに起動することを防ぎます。この状態になった場合は、表示
  された PID ファイルを削除してから再度起動してください。

### 修正

- `.kovitoboard/setting.json` の `project.path` は絶対パスである必要が
  あり、ファイル読み込み時に検証されるようになりました（`additionalWorkRoots`
  と同じ挙動です）。以前は相対パスの場合、カレントディレクトリによって
  解決先が変わることがありました。
- 起動・停止時の残存プロセスの扱いがより慎重になりました。起動時は、
  同じプロジェクトの tmux セッションが既に存在する場合は 2 本目の
  supervisor の起動を拒否し、ポートが無関係なプロセスに占有されている
  場合は失敗せずに警告して次の空きポートを探します。停止時は、残存
  （defunct）プロセスを強制回収せず報告し、自プロジェクトに紐づく
  プロセスのみをクリーンアップします（ホスト全体には一切手を出しません）。

## [0.2.6] - 2026-06-15

### 修正

- KovitoBoard を開き直して既存セッションへ最初のメッセージを送るとき、
  そのメッセージがエージェントの準備完了と同時に送信されるようになりました。
  以前は手動で Enter を押すまで入力欄に未送信のまま残っていました。
- KovitoBoard 自体を Claude Code セッション内から起動した場合でも、
  KovitoBoard が起動するエージェントのトランスクリプトが永続化される
  ようになりました。以前は継承された `CLAUDE_CODE_*` 環境変数によって
  トランスクリプトが書き込まれず、セッション表示が無音のまま空白に
  なっていました。
- オンボーディング後に `--project-root` を付けない素の `npm start` でも、
  プロジェクトルートの解決に失敗せず `.kovitoboard/setting.json` を
  見つけて利用するようになりました。また、解決後の設定が KovitoBoard
  のクローン自身を指していたり、シンボリックリンク経由でクローンへ
  到達したりする場合には、壊れた状態で起動せずに明示的にエラーとして
  停止するようになりました。
- セッションをまだ開いていない起動直後に、ヘッダーが誤って「degraded」
  警告を表示することがなくなりました。アクティブなセッションが無い間は
  tmux の不在を正常として扱い、tmux が実際に停止したときだけ警告を
  表示します。

## [0.2.5] - 2026-06-15

### 変更

- Ambient サイドバーが横幅をより効率的に使うようになりました。セッション
  ラベルをヘッダーへ移し、ピン留め操作をエージェントピッカー横のコンパクト
  なアイコンにすることで、会話表示の領域を広げました。
- Ambient サイドバーの入力欄で、操作ボタンが入力フィールドと下端揃えになり、
  両者のわずかな縦ずれを解消しました。
- 主要動作確認(primary tested)の Claude Code バージョンを 2.1.177
  （`@stable` チャンネル）に引き上げました。

### 修正

- Claude Code の入力ボックスの下に追加の行（カスタムステータスラインなど）
  が表示される場合でも、信頼確認プロンプトの検出が確実に動作するように
  なりました。以前はそれらの行によってプロンプトがキャプチャ範囲の外へ
  押し出され、エージェントの起動が止まってしまうことがありました。

## [0.2.4] - 2026-06-11

ローカライズと表示の修正、ブラウザ favicon、ドキュメント更新を含む
メンテナンスパッチです。

### 追加

- KovitoBoard をブラウザのタブやブックマークで識別しやすくする favicon
  を追加しました。

### 変更

- 主要動作確認(primary tested)の Claude Code バージョンを 2.1.153
  （`@stable` チャンネル）に引き上げました。Anthropic の `@stable`
  dist-tag に追従しています。

### 修正

- エージェント追加画面のテンプレート説明が、選択中の表示言語で表示される
  ようになりました。以前は英語モードでも日本語の説明が表示されていました。
- テンプレートからエージェントを作成した後、一覧でエージェントの説明が
  欠落しなくなりました。
- 設定モーダル「基本」タブのフッターが、変更はページをリロードすると
  反映される旨を正しく表示するようになりました（以前は「保存後すぐに反映」
  と表示）。

### ドキュメント

- 「セッションモニター」機能を「ライブセッション」に改名し、単に閲覧する
  だけでなく、稼働中のセッションとやり取りできる（メッセージ送信・画像や
  ファイルの共有・セッションの再開や継続）双方向の機能であることを明確に
  しました。
- KovitoBoard を再び起動する手順（翌日・停止後・PC 再起動後）と、PC 起動時
  に自動で立ち上げる手順を追記しました。
- 経路 A の見出しの文言を「ターミナル不要」に更新しました。

## [0.2.3] - 2026-06-07

メンテナンスパッチ: ローカライズ修正とセキュリティ依存更新。

### 修正

- ドキュメントビューアのサンプルアプリが、ファイルの更新日時を表示中の言語で
  表示するようになりました。以前は選択言語に関わらず常に米国英語の書式でした。

### セキュリティ

- 同梱の `react-router-dom` を 7.17.0 に更新し、上流の High アドバイザリ 2 件
  （GHSA-49rj-9fvp-4h2h、GHSA-8x6r-g9mw-2r78）を解消しました。いずれも React
  Router の framework-mode サーバのみに影響し、KovitoBoard は React Router を
  宣言的モード（`<BrowserRouter>`）でクライアントサイドのみ使用しているため
  影響はありませんでした。本更新は依存関係の衛生対応として適用しています。

## [0.2.2] - 2026-05-31

同梱サンプルアプリのローカライズ修正と、小さな表示の改善です。

### 修正

- レシピベースのサンプルアプリが、ナビゲーションメニュー名とアプリ内の
  テキストを、表示言語の設定に合わせて表示するようになりました。これまでは
  英語表示に設定していても、同梱の Document Viewer が日本語のラベルや
  テキストを表示していました。
- Document Viewer のファイルツリーにある「開いているフォルダ」アイコンが
  はっきり見えるようになりました。これまでは閉じたフォルダのアイコンに比べて
  薄く表示されていました。

## [0.2.1] - 2026-05-30

全機能領域の手動 UX テストで見つかった利用者向け改善と、一般公開に向けた
セキュリティ強化のリリースです。

### Added（追加）

- 同梱サンプルアプリを、レシピのインストールフローを経由せずに直接
  有効化・無効化できるようになりました。アプリ画面は 3 タブ構成
  （アプリ / サンプルアプリ / レシピ）に再構成され、ドラッグ＆ドロップで
  並べ替えた順序が保持されます。
- 同梱サンプルアプリ「Document Viewer」が Markdown に加えて HTML
  ファイルを表示できるようになり、左ペインがアイコン付きのファイルツリーに、
  両ペインのスクロールバーが表示されるようになりました。
- 外部コントリビューター向けのガバナンス文書（プルリクエスト / Issue
  テンプレート、`CODEOWNERS`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、
  `CONTRIBUTING.md` の「外部コントリビューター向け」節）を追加しました。
- アプリ画面に、ドラッグ＆ドロップで並べ替えできることを示すヒントを
  表示するようになりました。

### Changed（変更）

- 「作業ルート」をサイドメニューの独立項目から、設定モーダルのタブに
  移動しました。
- KovitoBoard のテンプレートから作成したエージェントに、構造化フィールド
  マーカーが既定で含まれるようになり、性格・口調・追加指示をそのまま
  編集できるようになりました。
- サーバー側 `api/` コードを含むアプリのレシピ書き出し拒否メッセージを、
  行動を先に示し内部用語を避けた文面に改善し、配布可能にする方法が
  分かりやすくなりました。
- 「コード信頼済（同梱）」のトラストバッジを、アプリ表示領域の右上に
  配置しました。

### Fixed（修正）

- アプリごとの 3 点メニュー（レシピ書き出し / 無効化）が、ウィンドウの
  右端外に表示されて操作できなくなる問題を修正しました。
- セッション入力エリアで、添付・送信ボタンをテキストエリアと揃え、
  テキストエリアのスクロールバーを必要なときだけ表示し、Ambient
  サイドバーの入力欄が初期表示時に大きすぎる問題を修正しました。

### Security（セキュリティ）

- Document Viewer が、信頼できない HTML をサンドボックス化した iframe
  （スクリプトを実行しない opaque-origin の別ブラウジングコンテキスト）
  内で描画するようになり、悪意あるインラインスタイルがホスト UI
  （トラストプロンプトを含む）を覆い隠したり偽装したりできないように
  しました。
- Content-Security-Policy（`base-uri` / `object-src` / `form-action` /
  `frame-ancestors`）、メニューページのパス解決、アップロードの書き込み
  競合、YAML パーサーの DoS 対策を強化しました。
- `.git` ディレクトリの除外を、ベアリポジトリ・大文字小文字・Unicode
  異形によるバイパス試行に対して強化しました。
- `ws` を 8.21.0、`qs` を 6.15.2 に更新し、CVE-2026-45736 と
  CVE-2026-8723 を解消しました。
- ガバナンス文書からメンテナの個人メールアドレスを削除し、セキュリティ
  報告を GitHub の非公開脆弱性報告機能で受け付けるようにしました。

## [0.2.0] - 2026-05-26

セキュリティ + 設計 hardening リリース。保護パス参照、CLAUDE.md guidance
注入、プロセスライフサイクルコマンド、Capture API opt-in、推奨設定チェック、
trust marker UI、Rule of Two 警告を追加。新規 recipe install は v0.3.0
KovitoHub 連携 (signed-only モデル) まで一時的に無効化。

### Added — 保護パス参照 + CLAUDE.md guidance 注入

- `docs/agent-ref/12-protected-paths.md` に KB 管理パスと、直接編集の代わりに
  使うべき API/UI/CLI を集約。
- オンボーディング完了時、`<projectRoot>/CLAUDE.md` の
  `<!-- KB:GUIDANCE_START --> ... <!-- KB:GUIDANCE_END -->` マーカー間に
  KB ドキュメント (`kovitoboard/docs/agent-ref/INDEX.md`) への参照行を 1 回
  だけ自動注入。Claude Code エージェントが KB 関連タスクで参照できる。
- ブロックは自動管理。マーカーを削除した場合は再注入しない。注入を完全
  スキップしたい場合は、オンボーディング実行前に
  `.kovitoboard/setting.json` で `claudeMdGuidance.disabled = true` を設定。

### Added — プロセスライフサイクルコマンド

- `npm run kb:stop` で tmux セッションのクリーンアップと残存プロセス診断を
  含む graceful shutdown。
- `<projectRoot>/.kovitoboard/run/supervisor.pid` による多重起動拒否 +
  stale 検出フォールバック。
- 起動時 preflight check で tmux 3.4+ / Node.js / Claude CLI を検証。
- `docs/agent-ref/11-lifecycle.md` で KovitoBoard ユーザーの代理として動作
  するエージェント向けに start / stop プロトコルを文書化。

### Changed — 共有インストール防止

- `--project-root` (または `KOVITOBOARD_PROJECT_ROOT`) を明示せずに KB
  clone 内部から起動した場合、KovitoBoard は起動を拒否するようになった。
  README.md に記載の embedded deployment モデルを使用すること。
- cwd-fallback パスは異常系扱いとし、警告ログ + UI 上の確認を表示する。

### Added — a11y / exposed-context Capture API の opt-in 機構

- `window.kb.capture.snapshot()` (アクセシビリティツリー walker) や
  `window.kb.exposeContext()` を使うレシピアプリは、install 時に明示的な
  opt-in 承認が必要になった。レシピ manifest が
  `captureRequires: ['a11y' | 'exposed-context']` を宣言し、install
  warning ダイアログで kind 別の承認セクションをユーザーが明示的に
  チェックする。
- KB が発行し、レシピコードには露出しない per-mount capture token による
  trusted-host-mediated identity モデルが、body-based appId trust を置き
  換える。
- Grandfather 動作: v0.2.0 より前にインストールされた既存レシピは、
  `captureRequires: []` で capture アクセスを再承認なしで保持。

### Added — 起動時・オンボーディング時の Claude Code 推奨設定チェック

- 起動時、KovitoBoard は merged Claude Code 設定
  (`~/.claude/settings.json` + プロジェクトローカルの
  `.claude/settings.json`) を検査し、以下 3 つの推奨設定のいずれかが
  欠落していると警告: `permissionMode` が `default`/`acceptEdits`/`plan`
  でない、`.kovitoboard/` deny pattern が `permissions.deny` に存在
  しない、bypass モードが有効。
- オンボーディング済みユーザーには toast (24 時間 dismiss cooldown、
  drift 検出時に dismiss 無効化) として、初回ユーザーにはオンボーディング
  wizard 内の Security ステップとして表示。rubber-stamp 承認を防ぐ
  per-item 確認 UI を提供。
- 設定ファイルは `fs.watch` でランタイム監視。変更時に再チェックが発火。
  ログ出力前に設定パスは redact (home マスキング + credential redaction)。

### Added — Trust marker UI + Rule of Two 警告

- Trust prompt UI に 5-level trust vocabulary indicator を追加、prompt
  injection の可能性があるパターンを surfacing する preamble warning。
- Claude Code Rule of Two bypass モードが有効な時に warning toast と
  オンボーディングステップを表示、per-item 確認を要求するゲート。

### Changed — レシピ install を一時的に無効化

- 本リリースでは `/api/recipes/install` 経由の新規レシピ install は
  **無効化** されている。endpoint は 410 Gone を返し、UI の install
  ボタンは非表示 / 無効化され「Coming in v0.3.0 with KovitoHub」と表示。
- v0.1.x または v0.2.0 でインストール済みの既存レシピは変更なく動作
  (grandfather)。View / uninstall / export フローは維持。
- KovitoBoard のレシピ配布は KovitoHub 経由の signed-only モデル
  (publisher signing + central marketplace、v0.3.0 で予定) に移行中。
  ローカル test / dev 用途のための developer sideload モード (opt-in
  via `KB_DEVELOPER_MODE=1`) も v0.3.0 で予定。
- 全体的な背景は `README.md` の "Recipe distribution model" セクション
  を参照。

### Security

- HTTP API + WebSocket upgrade に per-launch 認証 token を導入
- backend + Vite dev server を 127.0.0.1 に bind
- mark-installed を one-shot install-session nonce でゲート
- dispatcher resolved path を HandlerContext 経由で伝達 (TOCTOU)
- 構造化ログレコードから Anthropic API key / JWT を redact
- 直接の `console.*` 呼び出しを pino backed logger に移行
- カスタムバックエンドファイルを含むアプリの recipe export を拒否
- JSON store 用の atomic write helper を導入
- Install warning ダイアログに safety boundary + trusted-code モデル
  を明示
- handler dispatch を appId 単位で serialize
- `/api/artifact` の exclusion list + size cap を強制
- recipe export での appId path-traversal 防御
- recipe-parser entry での DoS 上限値強制
- recipe parser での artifact-path traversal 拒否
- WebSocket heartbeat + dead-connection termination
- `KOVITOBOARD_E2E_TMUX_SESSION` を `KB_E2E_MODE` ゲート配下に
- recipe scope validator の operation-aware exclusion
- spawn / tmux consumer の cwd allow-list ゲート
- tmux `sendViaBuffer` tmpfile を 0600 + O_EXCL で hardening
- server-side catch envelope redaction
- trust prompt respond race 用の server-side dedup ledger
- legacy anchor detection 削除
- agent-ref install / `kb-stop --all` の path hardening

### Notes

- いくつかの install フロー hardening 項目 (install verdict trust /
  recipe hash scope / Expand All review gate / KH registration warning
  / install preview) は、v0.2.0 で install endpoint が無効化されている
  ため v0.3.0 持ち越し、signed-only モデルの下で再評価。
- v0.2.0 は引き続き private (closed)。public ランディングページ
  更新は v0.2.1 で予定。

### Migration notes

#### 共有インストール拒否 (以前は silent fallback)

KovitoBoard clone 内部から `npm run dev` を起動すると ERROR で終了
するようになった。`npm start -- --project-root <path-to-claude-code-project>`
を使うか、`KOVITOBOARD_PROJECT_ROOT` を設定する。KovitoBoard 本体を
開発する contributor は project root を明示的に渡すこと。

#### KovitoBoard の停止

`Ctrl+C` の代わりに `npm run kb:stop` を使うと supervisor / tmux
セッション / Vite dev server が clean shutdown される。contributor
向けに `Ctrl+C` も引き続き動作する。

#### レシピ install を一時的に無効化 (既存レシピは grandfather)

v0.2.0 では `/api/recipes/install` 経由のレシピ install を無効化。UI の
install ボタンは非表示 / 無効化され「Coming in v0.3.0 with KovitoHub」
と表示。

- **既存レシピ** (v0.1.x または v0.2.0 でインストール済) は変更なく
  動作。アクションは不要。
- **新規レシピ install** は v0.3.0 まで利用不可。
- **開発者** がローカルでレシピを test / 開発する必要がある場合は、
  developer sideload モード (opt-in via `KB_DEVELOPER_MODE=1`) が
  v0.3.0 で予定されている。
- 全体的な背景は `README.md` の "Recipe distribution model" セクション
  を参照。

#### tmux 3.4+ 要件

起動時 preflight check で tmux 3.4+ を要求するようになった。それより
古いバージョンは明確なエラーメッセージと remediation 手順を表示して
終了する。v0.2.0 を実行する前に tmux を 3.4 以降にアップグレードする。

## [0.1.1] - 2026-05-06

自動更新検出 + エージェント主導アップグレードフローの検証用リリース。
新機能なし — アップグレード時のマージ処理を検証するための既知サーフェスとして、
i18n 文言の軽微な調整のみを実施。

### 変更

- `onboarding.welcome.subtitle`: オンボーディング画面のサブタイトル文言を変更
  (`src/renderer/i18n/{ja,en}.ts`)。
- `ambientSidebar.placeholder`: アンビエントセッションサイドバーの空状態
  プレースホルダ文言を変更(`src/renderer/i18n/{ja,en}.ts`)。
- `version.loadFailed`: バージョン情報取得失敗時のエラーメッセージ文言を変更
  (`src/renderer/i18n/{ja,en}.ts`)。

## [0.1.0] - 2026-05-05

初回リリース(クローズドβ)。

### 追加

- オンボーディング 5 ステップフロー(コンシェルジュエージェント「コビー」自動配置)
- レシピのインストール / 再インストール / 書き出しフロー(宣言的 scope 契約、DEC-006 v2.0)
- 独自アプリの新規作成 / 削除のライフサイクル管理(EU9)
- 画面コンテキスト連動のアンビエントセッションサイドバー
- Trust prompt の UI 中継(folder-trust / Write / Edit / Bash パターン)
- 永続ロギング基盤(pino + JSON Lines + 日次ローテ + デフォルト 7 日保持) + `npm run diagnose` Markdown レポート
- エージェント参照ドキュメント(`docs/agent-ref/` 全 9 章、日本語 + 英語ポインタ)
- サーバーヘルス UI(ステータスインジケータ + popover、5 秒ポーリング)
- バージョン表示(KB バージョン / Claude Code バージョン + ティア / 更新チェック)
- 日本語 / 英語の完全 i18n

### 注記

- クローズドβリリース。公開告知およびランディングページ更新は v0.2.1 で予定。
