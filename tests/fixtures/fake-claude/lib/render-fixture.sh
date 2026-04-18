#!/bin/bash
# lib/render-fixture.sh
# fixture を tmux 画面に表示する共通 helper
#
# 使用する fixture ディレクトリを FIXTURE_DIR 環境変数で指定可能。
# 未指定時は tests/fixtures/trust-prompts/claude-2.1.97 を参照する。

FIXTURE_DIR="${FIXTURE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../fixtures/trust-prompts/claude-2.1.97" && pwd)}"

render_fixture() {
  local name="$1"
  local path="$FIXTURE_DIR/$name"
  if [ ! -f "$path" ]; then
    echo "Fixture not found: $path" >&2
    exit 3
  fi
  # 画面をクリアしてから表示（前の状態が残らないようにする）
  printf '\033[H\033[2J'
  cat "$path"
}
