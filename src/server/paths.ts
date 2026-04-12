/**
 * KovitoBoard のデータ保存先パス定数
 *
 * KovitoBoard はプロジェクトルート直下の `.kovitoboard/` を
 * ランタイムデータの保存先として使用する。
 *
 * - `.kovitoboard/session-agents.jsonl`: セッション↔エージェント紐付け記録
 * - `/tmp/kovitoboard-uploads/`: 一時アップロードファイル置き場
 *
 * 定数は遅延評価（関数）で提供する。
 * `resolveProjectRoot()` は `__dirname` に依存するため、
 * モジュールロード時に即時評価するとテスト時にパスがずれる可能性がある。
 */
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveProjectRoot } from './config'

/** プロジェクトルート直下の `.kovitoboard/` ディレクトリ */
export function getKovitoboardDir(): string {
  return join(resolveProjectRoot(), '.kovitoboard')
}

/** セッション↔エージェント紐付け記録ファイル */
export function getSessionAgentsRecordPath(): string {
  return join(getKovitoboardDir(), 'session-agents.jsonl')
}

/**
 * アップロード一時ファイルディレクトリ
 * システムの tmp 配下に配置する（プロジェクトを汚染しない）
 */
export function getUploadDir(): string {
  return join(tmpdir(), 'kovitoboard-uploads')
}

/**
 * `.kovitoboard/` ディレクトリが存在しない場合は作成する。
 * サーバー起動時に 1 回呼び出せばよい。
 */
export function ensureKovitoboardDir(): void {
  const dir = getKovitoboardDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[paths] .kovitoboard/ を作成しました: ${dir}`)
  }
}
