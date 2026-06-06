# 11. KovitoBoard のプロセス・ライフサイクル

**対象 KB バージョン:** v0.2.2
**最終更新:** 2026-05-31

> 📖 **この章を読むタイミング:** ユーザーからエージェントが「KovitoBoard を起動して」「KovitoBoard を停止して」「KovitoBoard を再起動して」と頼まれたとき、または多重起動エラー・stale な PID ファイル・KB プロセスに関する疑問に遭遇したとき。KB 自身の内部で動くエージェント（Kovito コンシェルジュ「コビー」/ Kovito 開発者 / 秘書）は、プロセス操作を検討する前に必ず §5 を読んでください。

---

## この章の目的

KovitoBoard の起動・停止のあり方は意図的に狭く設計されています。サポートされる入口はすべて `tools/kb-start.mjs`（スーパーバイザ）と `tools/kb-stop.mjs`（クリーナー）を経由します。この章では、3 種類のエージェント利用者すべてが従うべきプロトコルを定義します。

- CLI を直接実行する KB ユーザー。
- ユーザーのプロジェクト内で動き、組み込み KB の起動・停止を依頼される Claude Code エージェント。
- 実行中の KB セッションの *内部* で動く KB 内部エージェント（自分自身を停止してはならない）。

エージェントが反射的に `pkill`・`tmux kill-server`・`kill -9`・`npm run dev` を呼ぼうとしたら、その反射は誤りです。先にこの章の残りを読んでください。

---

## §1 2 つの公式コマンド

```bash
# Start KovitoBoard (embedded model)
cd <project>/kovitoboard
npm start -- --project-root ..
```

```bash
# Stop KovitoBoard
cd <project>/kovitoboard
npm run kb:stop
```

これが通常運用におけるユーザー向けの操作面のすべてです。

`npm run dev` も存在しますが、これは **KB のコントリビューター専用** です。スーパーバイザをバイパスするため、`npm run kb:stop` では検出も停止もできません。ユーザーの依頼を果たす際にエージェントが `npm run dev` を推奨・実行してはいけません。

---

## §2 KB の起動（エージェント向けプロトコル）

ユーザーがエージェントに「KovitoBoard / KB を起動して」と頼んだら、次を行います。

1. `pwd` を実行し、自分がユーザーのプロジェクトディレクトリ（`kovitoboard/` の親）にいることを確認する。
2. `<project>/kovitoboard/package.json` が存在することを確認する。存在しなければ、ユーザーに「このプロジェクトに `kovitoboard/` サブディレクトリが見つかりません」と伝えて停止する。
3. `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` を確認する:
   - ファイルが存在 + pid が生存（`kill -0 <pid>` が成功）→ KB は既に起動済み。ユーザーに「KovitoBoard は既に起動しています（pid=N）」と伝え、PID ファイルの `ports.vite` フィールドを読んで URL `http://localhost:<port>` を案内する。2 つ目のスーパーバイザを起動 **しない**。
   - ファイルが存在 + pid が死亡（ESRCH）→ stale な PID ファイル。無害なので続行する。
   - ファイルが存在しない → 続行する。

> ℹ️ **`kill -0` が保証すること・しないこと:** `kill -0 <pid>` が成功するのは「その pid を持つプロセスが存在し、シグナルを送る権限がある」ことだけです。**その pid が本当に KB スーパーバイザであることまでは保証しません。** 稀なケースとして、元のスーパーバイザが死亡した後に OS が同じ pid を無関係なプロセスに再割り当てしている（PID reuse）と、`kill -0` は成功するのに案内する `ports.vite` の URL が古い／無関係になりえます。これは PID ファイルベースの判定の構造的な限界であり、通常運用では問題になりません。
>
> **重要 — PID reuse を疑うときに `kb:stop` を使わないこと:** 案内した URL に KB が応答しないとユーザーが報告した場合、`npm run kb:stop` で「いったん止める」ことは **してはいけません**。PID ファイル経由の停止は `supervisor.pid` に記録された pid を再検証せず SIGTERM を送るため、その pid が再利用された無関係なプロセスだと、KB と無関係なプロセスを kill してしまいます（プロセス実体の検証を伴う絞り込みは §6 の `--all` 経路だけが行います）。代わりに、**PID ファイル `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` を確認し、記録された pid が本当に KB スーパーバイザか（例: `ps -p <pid> -o command=` でコマンドラインを確認）を検証**してください。KB でないと分かったら、その PID ファイルを取り除いてから §2 で起動し直します。**注意:** このケースでは pid が生存しているため `kb-start` は PID ファイルを自動では上書きしません（pid が死んでいる通常の stale ケースとは異なり、生存 pid を「起動済み」と見なして終了コード 1 で拒否します）。そのため復旧には当該 PID ファイルの手動削除が必要で、これは `12-protected-paths.md` §2 に明記された唯一の例外です（検証済みの非 KB プロセス + 当該ファイル 1 つだけの削除に限定。「再起動を強制する」目的での削除は §3 のとおり引き続き禁止）。
4. **正確に** 次のコマンドを実行する:
   ```bash
   cd <project>/kovitoboard && npm start -- --project-root ..
   ```
5. スーパーバイザの出力を見守る。`[kb-start] Frontend: http://localhost:<port>` が表示されたら、その URL をユーザーに渡す。

### 起動時に絶対にしないこと

- `npm run dev` を実行しない（コントリビューター専用、スーパーバイザをバイパスする）。
- `--project-root` なしで KB clone 内部から実行しない。スーパーバイザが明示的なエラーメッセージと終了コード 1 で拒否する。
- `<project>/kovitoboard/` 以外のディレクトリから KB を起動しない。
- `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` を手で編集しない。

---

## §3 KB の停止（エージェント向けプロトコル）

ユーザーがエージェントに「KovitoBoard / KB を停止して」と頼んだら、次を行います。

1. `<project>/kovitoboard/package.json` が存在することを確認する。
2. **正確に** 次のコマンドを実行する:
   ```bash
   cd <project>/kovitoboard && npm run kb:stop
   ```
3. 終了コードを読む:
   - **0** → 完了。KovitoBoard がクリーンに停止したとユーザーに伝える。
   - **3** → graceful shutdown がタイムアウトした。ユーザーに「`--force` で再試行してよいですか？」と尋ね、了承を得たら `npm run kb:stop -- --force` を実行する。
   - **4** → 部分的成功。スーパーバイザは停止したが、残留プロセスが検出された（`kb-stop` が stderr に出力）。残留リストをユーザーに見せ、`--force` にエスカレーションするか尋ねる。
   - **2** → 権限拒否（おそらく別ユーザーの所有）。報告して停止する。明示的な依頼なしに昇格権限で再試行しない。
4. `pkill`・`kill -9`・`tmux kill-server`・`pkill -f kb-start` をデフォルトで使わない。公式の `kb:stop` コマンドが上記のコードで終了するのには理由があります。その診断出力が、あなたとユーザーに次に何をすべきかを既に伝えています。

### 停止時に絶対にしないこと

- `kb:stop` 自体が失敗した場合を除き、PID ファイルを使って `kill <pid>` を直接実行しない。
- `tmux kill-server` を実行しない。ホスト上の KovitoBoard と無関係なものを含むすべての tmux セッションを kill してしまう。
- 「再起動を強制する」ために `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` を手で削除しない。多重起動ガードが外れ、何が動いていたかの記録がホストから消える。

---

## §4 多重起動エラーと stale な PID ファイル

`npm start` が `[kb-start] ERROR: KovitoBoard supervisor is already running (pid=N)` で終了した場合:

1. `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` を読む。JSON には `ports.vite` が含まれ、URL は `http://localhost:<vite-port>` となる。
2. ユーザーが起動中の KB に **アクセスしたい** なら、URL を案内する。
3. ユーザーが KB を **再起動したい** なら、§3（`npm run kb:stop`）を行ってから §2（`npm start -- --project-root ..`）を行う。

`kb-start` が `WARN: stale PID file detected` を報告した場合、これは情報提供にすぎません。前のスーパーバイザがクリーンアップせずに死亡し、`kb-start` が既にファイルを上書きしています。エージェントの操作は不要です。

---

## §5 KB の *内部* で動くエージェントは KB を停止してはならない

あなたのエージェント定義が次のいずれかなら:

- Kovito コンシェルジュ（コビー）
- Kovito 開発者
- 秘書
- その他、tmux セッションが `kovitoboard-<projectDir>` セッション内部に存在するエージェント

…次のいずれも **絶対に** 実行してはいけません:

- `npm run kb:stop`
- `tmux kill-server`
- 自分自身のセッションに対する `tmux kill-session`
- `kill <supervisor-pid>` / `kill -9 <supervisor-pid>`
- あなたをホストしているスーパーバイザを終了させるあらゆるコマンド

KB を停止すると、あなたの tmux ウィンドウが停止します。`kb-stop` に自殺防止ガードがあるとしても（実際にあります。下記の `--force` 注記を参照）、KB 内部エージェントが正当に KB を停止する必要があるシナリオは存在しません。ユーザーから「KB の内部から KovitoBoard を再起動して」と頼まれたら、こう返してください:「このセッションの内部からは KovitoBoard を再起動できません。KovitoBoard の外側でターミナルを開き、`npm run kb:stop` の後に `npm start -- --project-root ..` を実行してください。」

このルールは `agent-ref/10-upgrade.md` §7.4（「KB のセルフ再起動は禁止」）と同じ系統です。どちらも、エージェントが自分を動かしているまさにそのプロセスを kill してしまい、ユーザーに戻る経路が残らない状況を防ぎます。

多層防御として、`kb-stop.mjs` 自身も、現在自分が動いている tmux セッションの kill を拒否します（警告してそのセッションをスキップする）。上記のエージェント側ルールが第一の防御線です。

---

## §6 `kb-stop` がすること・しないこと

`kb-stop` は次の順で実行します:

1. PID ファイルを読む。存在しない場合（または `--all` 指定時）は `pgrep -f tools/kb-start.mjs` にフォールバックする。このフォールバックは候補を **この clone から起動されたスーパーバイザだけに絞り込む**（下記の narrowing 注記を参照）ため、同じマシン上の別プロジェクトの KB を巻き込みません。
2. 見つかった各スーパーバイザ pid に `SIGTERM` を送る。
3. PID ファイルが消えるのを最大 5 秒待つ（スーパーバイザの shutdown ハンドラが、公開向けの「停止処理中」シグナルとしてこれを削除する）。
4. `--force` 指定でタイムアウトした場合、`SIGKILL` にエスカレーションする。
5. PID ファイルに記録された tmux セッション（`tmux.sessionName`）を kill する。`--all` に加えて `KB_FORCE_TMUX_PREFIX_KILL=1` を付けると、`kovitoboard-` で始まる名前の残存 `tmux ls` セッションもすべて kill する。
6. 残留する `tsx watch`・`vite`・`claude` プロセスを報告する。`--force` なしの場合、これらは報告されるだけで kill **されない**。判断はオペレータに委ねられる。

`kb-stop` が **しない** こと:

- デフォルトでプロジェクトルート外のプロセスに触れる（プレフィックス全体の tmux kill はオプトイン）。
- 自分自身が動いている tmux セッションに影響する（自殺防止ガード、§5 参照）。
- 何かを再起動する。それは `kb-start` の役割。

> ℹ️ **`--all` の pgrep フォールバックの絞り込み（narrowing）:** `--all`（または PID ファイル不在）時の `pgrep -f tools/kb-start.mjs` は、文字列が一致しただけのプロセスを無差別に kill しません。各候補の **エントリスクリプトの実パス（realpath）が、この clone の `tools/kb-start.mjs` と一致するか** を検証して絞り込みます（相対パスで起動された候補は `/proc/<pid>/cwd` を使って解決します）。エントリスクリプトを安全に特定できない候補は kill せず WARN でスキップします。この結果、別 clone・別プロジェクトのスーパーバイザは構造的に対象外になり、「デフォルトでプロジェクトルート外に触れない」という上記の保証が `--all` 経路でも成立します。

---

## §7 よくある質問

**「KB を再起動するには？」**
→ `npm run kb:stop` の後に `npm start -- --project-root ..`。単一の「再起動」コマンドが無いのは意図的です。2 ステップ形式により多重起動ガードが正しく保たれます。

**「スーパーバイザの pid を `kill` するだけでもいい？」**
→ 可能ですが、tmux クリーンアップ・残留診断・決定論的な終了コードをスキップしてしまいます。まず `kb:stop` を使い、`kb:stop` 自体が壊れているときだけ手動 `kill` にフォールバックしてください。

**「CI スクリプトで非対話の停止がしたい。」**
→ `npm run kb:stop -- --force` は非対話コンテキストで安全です。0 / 3 / 4 を決定論的に返し、入力待ちでブロックしません。

**「マシン上に `kovitoboard-...` の tmux セッションが 2 つ見える。」**
→ 2 つの異なるプロジェクト用に 2 つの KB clone を動かしている（embedded model では想定内）か、片方のスーパーバイザが死亡して孤立した tmux セッションを残したかのどちらかです。`npm run kb:stop -- --all`（`KB_FORCE_TMUX_PREFIX_KILL=1` 付き）で一掃できますが、両方のセッションが KovitoBoard のものだと理解している場合に限り実行してください。

**「起動バナーでプロジェクトパスの横に `(cwd fallback)` と出る。」**
→ `kb-start` が `--project-root` も `KOVITOBOARD_PROJECT_ROOT` も見つけられず、たまたま cwd が KB clone の外側にあった、という状態です。KB は動きますが、プロジェクトルートが意図したものでない可能性があります。`kb:stop` で停止し、明示的な `--project-root` を付けて再起動してください。
