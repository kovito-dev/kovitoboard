[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

# 変更履歴

KovitoBoard の主要な変更点を本ファイルに記録します。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

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
