# 10. KovitoBoard のバージョンアップ

**対象 KB バージョン:** v0.2.7
**最終更新:** 2026-06-15

> 📖 **この章を読むタイミング:** ユーザーから「KB をアップデートして」と依頼された / ヘッダーに「KB の新版が公開されています」警告が出ている / git pull で衝突してアップデートが詰まっている / アップデート後に動かなくなった、という場合。

---

## この章の目的

KovitoBoard（KB）のバージョンアップを **安全に完遂する** ための手順とユーザーエージェント向けプロトコルを定義します。KB のバージョンアップは従来の npm パッケージ・配布バイナリのアップデートとは性質が異なるため、この章を読んでから作業してください。

## 目次

- §1 KB のバージョンアップが従来と違う理由
- §2 バージョンアップ前の準備（事前点検）
- §3 バージョンアップ手順（標準フロー）
- §4 conflict 発生時の対処
- §5 バージョンアップ後の整合性確認
- §6 rollback（戻したい場合）
- §7 ユーザーエージェント向けプロトコル

---

## §1 KB のバージョンアップが従来と違う理由

KB は次の 3 つの構造的な特徴を持っており、これらが「バージョンアップ手順の特殊性」の源です。

### 1.1 git clone ベース（npm パッケージではない）

- 配布形態は **`git clone` で手元に置く** のが標準
- 「アプリの再インストール」はなく、**`git pull` でコードを更新する**
- ユーザーが手を入れた箇所は git の merge / conflict 解決で対処する必要がある

### 1.2 ユーザー資産が同じ working directory に同居

KB のリポジトリ配下には、KB コアと **ユーザー資産** が同居しています:

| パス | 性質 |
|---|---|
| `src/` | KB コア（git 追跡対象。原則改変しない） |
| `app/` | ユーザー独自アプリ（`.gitignore` 対象、ユーザー資産） |
| `recipes/` | KB サンプルレシピ（git 追跡対象） |
| `.kovitoboard/` | レシピ専用 KV / ログ / インストール済みレシピ manifest（`.gitignore` 対象、ユーザー資産） |
| `package.json` / `package-lock.json` | KB の依存定義（git 追跡対象） |

`app/` と `.kovitoboard/` は `.gitignore` で守られているため、`git pull` で消えることはありません。**ただし `src/` をユーザーが直接改変している場合（`05-apps.md` §1.1.1 参照）は衝突が発生します**。

### 1.3 レシピのコア依存

レシピは KB コアの handler セット（Category A の 9 個）と scope モデル（7 種）に依存しています（`04-recipes.md` §6 参照）。KB 本体が MAJOR バージョンアップでこの handler セットを変更した場合、既存レシピが動かなくなる可能性があります。

KovitoBoard のバージョニングポリシーでは PATCH / MINOR / MAJOR の意味が定義されているので、アップデート時はその意味に応じた確認が必要です:

- **PATCH（0.1.0 → 0.1.1）**: 既存機能の互換性を維持。レシピ・自作アプリへの影響は基本なし
- **MINOR（0.1.x → 0.2.0）**: 機能追加。既存レシピは原則動作するが、要動作確認
- **MAJOR（0.x.y → 1.0.0）**: 破壊的変更を含む可能性。レシピ・自作アプリの再対応が必要な場合あり

---

## §2 バージョンアップ前の準備（事前点検）

`git pull` を実行する **前に** 必ず以下を確認してください。スキップすると詰まります。

### 2.1 KB の作業ディレクトリに移動

```bash
cd ~/workspace/kovitoboard
# またはユーザーが clone した場所
```

### 2.2 git の状態を確認

```bash
git status
git branch --show-current
```

**確認ポイント:**

- **branch が `main` か** — main 以外の branch にいる場合、ユーザーに「main に戻してから進めてよいか」を確認
- **未コミット変更があるか** — 後述の §2.3 を実施
- **upstream（origin/main）と何 commit 離れているか:**
  ```bash
  git fetch origin
  git rev-list --left-right --count HEAD...origin/main
  ```
  出力形式: `LEFT\tRIGHT`（LEFT = ローカル独自 commit / RIGHT = 上流に未取得 commit）

### 2.3 未コミット変更がある場合

`git status` で「Changes not staged」「Untracked files」がある場合、変更箇所によって対処が異なります:

| 変更場所 | 対処 |
|---|---|
| `app/` 配下のみ | `.gitignore` 対象なので git pull に影響しない。そのまま進めてよい |
| `.kovitoboard/` 配下のみ | 同上 |
| `recipes/` 配下 | git 追跡対象。`recipes/` 配下を改変しているのは稀なので、ユーザーに状況確認 |
| **`src/` 配下** | **要警戒**。05-apps.md §1.1.1 の規範違反。ユーザーに「このまま進めると衝突する可能性が高い」と説明し、stash / commit / 破棄のいずれかを選んでもらう |
| `package.json` / `package-lock.json` | npm install で書き換わったまま放置されている可能性。ユーザーに状況確認 |

未コミット変更を退避するコマンド例:

```bash
# 一時退避（後で git stash pop で戻せる）
git stash push -u -m "before-upgrade-$(date +%Y%m%d)"

# またはユーザー判断でコミット
git add -A && git commit -m "WIP before upgrade"

# または完全に破棄（注意: 戻せない）
git checkout . && git clean -fd
```

### 2.4 インストール済みレシピの確認

```bash
ls .kovitoboard/recipes-installed/ 2>/dev/null
cat app/menu.ts 2>/dev/null
```

インストール済みレシピがある場合、MAJOR バージョンアップなら動作確認が必要であることをユーザーに事前共有します。

### 2.5 アップデートの種別を判定

```bash
# 現在のバージョン
node -p "require('./package.json').version"

# 上流の最新タグ
git fetch --tags origin
git tag --sort=-v:refname | head -3
```

PATCH / MINOR / MAJOR のどれかをユーザーに伝え、特に MINOR / MAJOR では「既存レシピと自作アプリへの影響を後で確認する必要がある」と前置きします。

---

## §3 バージョンアップ手順（標準フロー）

§2 の事前点検が完了したら、以下を順に実行します。

### 3.1 上流の変更概観

```bash
git fetch origin
git log HEAD..origin/main --oneline
git diff HEAD..origin/main --stat
```

- どのファイルがどれだけ変わるか把握
- ユーザーに重要そうな変更（`src/server/` のコア変更、`recipes/` のサンプルレシピ追加等）があれば一言伝える

### 3.2 conflict 可能性の事前判定

```bash
# src/ にローカル変更があるか
git diff origin/main -- src/ | head -50
```

- 出力が大量（≧ 数十行の差分）なら conflict 確率高め。ユーザーに警告
- 出力が空 or わずかなら、ほぼ安全に pull できる

### 3.3 git pull 実行

```bash
git pull origin main
```

- 成功した場合 → §3.4 へ
- conflict が発生した場合 → §4 へ

### 3.4 依存パッケージの更新

```bash
npm install
```

- `package-lock.json` が変わっている場合は必須
- 新しい依存が追加された場合、ここで取得される

### 3.5 KB 再起動の案内

```bash
# 起動中の KB を停止（Ctrl+C 等）してから:
npm start -- --project-root /path/to/your/project
```

ユーザーに「KB を再起動してください」と明示的に伝えます。**エージェント側で勝手に再起動しない**（再起動するとエージェント自身のセッションが切れる可能性）。

---

## §4 conflict 発生時の対処

`git pull` で `CONFLICT (content): Merge conflict in <path>` が出たら、以下の手順で対処します。

### 4.1 まず立ち止まる

**自動的に解決しない**。ユーザーに状況を共有してから次のステップを選びます:

```bash
git status
```

`Unmerged paths:` セクションに conflict 発生ファイルが列挙されています。

### 4.2 各 conflict ファイルの判断

ファイルを開いて `<<<<<<< HEAD` ... `=======` ... `>>>>>>> origin/main` のマーカーを確認します。

**意思決定の選択肢:**

| 選択肢 | コマンド | 適用条件 |
|---|---|---|
| 上流を採用（自分の変更を捨てる） | `git checkout --theirs <path>` | ユーザーが自分の変更を保持しなくてよいと判断した場合 |
| 自分の変更を採用（上流を捨てる） | `git checkout --ours <path>` | 上流変更を採用すると自分の修正が壊れる場合（要警戒） |
| 手動マージ | エディタで両方を統合して保存 | 両方の変更を残したい場合 |

**重要:** ユーザーに必ず選択肢を提示し、意思決定を仰いでから実行します。**勝手に theirs / ours を選ばない**。

### 4.3 conflict 解決後

```bash
# マーカーを残したまま add しないよう注意
grep -rn '<<<<<<<' . 2>/dev/null  # マーカー残存チェック

git add <conflict が解消したファイル>
git commit  # マージコミットを作成
```

### 4.4 中断したい場合

「やっぱり今はアップデートしない」とユーザーが判断したら:

```bash
git merge --abort
```

これで pull 前の状態に戻ります。

### 4.5 conflict が複雑すぎる場合

- conflict ファイル数が多い（≧ 5 ファイル）
- `src/server/` のコアファイルに conflict
- ユーザーが過去に `src/` を改変した記憶がある

これらの場合は **エージェント単独で進めず、康輔さん（または KB の保守担当者）に相談する** ようユーザーに勧めます。05-apps.md §1.1.1 の警告通り、`src/` 改変はもともと推奨されていません。

---

## §5 バージョンアップ後の整合性確認

`git pull` + `npm install` + 再起動が完了したら、以下を確認します。

### 5.1 起動確認

- KB のサーバが起動した（`npm start` の出力末尾に表示される `[kb-start] Frontend: http://localhost:<port>` の URL で接続できる。デフォルトは 5173 だが、競合時は 5174 等に自動フォールバックする）
- ステータスインジケータが 🟢 になっている
- ヘッダーに警告が出ていない（または `Claude Code 範囲外` 警告のみ → 別問題）

### 5.2 自作アプリ（`app/`）の動作確認

- `app/menu.ts` のメニューエントリがサイドバーに出ている
- 各画面を開いて動作する
- `app/api/*.ts` の API が応答する（fetch して 200 が返る）

### 5.3 インストール済みレシピの動作確認

- `app/menu.ts` 内のレシピ起源エントリが残っているか
- 各レシピ画面を開いて動作する
- レシピが handler を呼ぶ箇所でエラーが出ていないか（`.kovitoboard/logs/server.log` 確認）

### 5.4 ログ確認

```bash
tail -100 .kovitoboard/logs/server.log
```

`level: "error"` や `WARN` が出ていないか確認。出ている場合は §6 rollback も含めて検討。

### 5.5 PATCH / MINOR / MAJOR 別の追加確認

- **PATCH:** §5.1 のみで十分
- **MINOR:** §5.1 〜 §5.3 を実施
- **MAJOR:** §5.1 〜 §5.4 すべて + ユーザーに「破壊的変更による影響が出ていないか」を一緒に確認

---

## §6 rollback（戻したい場合）

アップデート後に問題が出た場合、以下の手順で戻せます。

### 6.1 git の reflog で復帰ポイント確認

```bash
git reflog | head -20
```

`git pull` 直前の commit hash を見つけます（`HEAD@{N}` 形式）。

### 6.2 戻す

```bash
git reset --hard HEAD@{N}  # N は §6.1 で見つけた番号
```

**注意:** `--hard` は未コミット変更を完全に破棄します。§2.3 で stash していた場合は、reset 後に `git stash pop` で復元できます。

### 6.3 npm 依存も戻す

```bash
npm install
```

`package-lock.json` が古いバージョンに戻っているので、それに従って依存も戻ります。

### 6.4 KB 再起動

§3.5 と同じ手順で再起動。

### 6.5 戻せない場合の最終手段

git の reflog エントリも消えてしまった / repo が壊れた、という場合:

```bash
# 元の repo を別ディレクトリに新規 clone
cd ~/workspace
mv kovitoboard kovitoboard-broken
git clone <repo-url> kovitoboard
cd kovitoboard
git checkout <戻したいタグ>  # 例: v0.1.0
npm install

# ユーザー資産を移動
cp -r ../kovitoboard-broken/app ./
cp -r ../kovitoboard-broken/.kovitoboard ./
```

これでユーザー資産を保持したまま、コア部分のみクリーンに戻せます。

---

## §7 ユーザーエージェント向けプロトコル

ユーザーから「KB をアップデートして」と依頼された場合、または KB のヘッダーから「アップデートする」ボタン経由で起動された場合、エージェントは以下のプロトコルに従って作業してください。

### 7.1 標準実行手順

1. **ユーザーへの初期確認:**
   - 現在の作業途中のものがないか確認（あれば一旦コミット or stash を提案）
   - アップデート種別（PATCH / MINOR / MAJOR）を伝え、想定される影響範囲を共有
2. **§2 事前点検を全項目実施**
3. **§3 標準フロー実行**
   - §3.2 で大きな差分が出た場合、ユーザーに警告してから §3.3 に進む
4. **conflict 発生時は §4 に従う**
   - 自動解決しない、必ずユーザーに選択肢を提示
5. **§5 整合性確認をアップデート種別に応じた粒度で実施**
6. **完了報告**:
   - 何が更新されたか（例: v0.1.0 → v0.1.1、変更内容のサマリ）
   - §5 の確認結果
   - 問題があれば §6 rollback も提案

### 7.2 ユーザーへの確認が必須なポイント

エージェントが **勝手に判断してはいけない** ポイント:

- 未コミット変更の処理（stash / commit / 破棄のどれか）
- conflict 解決時の選択（theirs / ours / 手動マージ）
- `src/` 配下のユーザー改変が見つかった場合の対処
- §5.4 でエラーが出た場合の rollback 判断
- 「やっぱり今はアップデートしない」という中断判断

### 7.3 危険な操作の警告

以下を実行する前は **必ず** ユーザーに警告 + 確認:

- `git checkout .` / `git clean -fd`（未コミット変更の完全破棄）
- `git reset --hard`（履歴を強制的に巻き戻す）
- `git push --force` / `git push --force-with-lease`（**バージョンアップ作業では基本不要**。出てきたら作業内容を疑う）
- `rm -rf` 系（特に `.kovitoboard/` や `app/` への破壊的操作）

### 7.4 KB の再起動はユーザー操作

エージェント自身が tmux セッションで動いている場合、KB の再起動はエージェントセッションを切る可能性があります。**再起動コマンドを直接実行せず**、ユーザーに「以下のコマンドで再起動してください」と提示するに留めます:

```bash
# 起動中の KB を停止して、再度:
npm start -- --project-root <既存プロジェクト>
```

### 7.5 完了後の振る舞い

- アップデート完了後、KB のヘッダー警告（「KB の新版が公開されています」）は **再起動後に消えるはず**
- 消えない場合: GitHub Releases の latest tag が更新されていない可能性 / キャッシュが残っている可能性。popover 内「いまチェック」ボタンの押下をユーザーに勧める

---

## 関連章

- 自作アプリの保護 → [`05-apps.md`](./05-apps.md) §1.1（`app/` の git ignore 扱い）
- `src/` 直接改変の警告 → [`05-apps.md`](./05-apps.md) §1.1.1
- アップデート時のレシピ動作確認 → [`04-recipes.md`](./04-recipes.md)
- ログ確認 → [`08-logging.md`](./08-logging.md)
- トラブルシュート → [`06-troubleshooting.md`](./06-troubleshooting.md)
