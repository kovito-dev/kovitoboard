#!/bin/bash
# scenarios/write-create.sh
# シナリオ: Write ツールによる新規ファイル作成 → 承認/拒否/セッション許可
#
# 状態遷移:
#   State 1: fixture「write-create-new-file.txt」を表示（trust prompt）
#   入力 "1" → Yes: 作成成功メッセージ表示
#   入力 "2" → Yes, and allow for session: 成功メッセージ表示（session-allowed）
#   入力 "3" → No: 拒否メッセージ表示 → exit 1
#   その他   → Unknown key → exit 2

set -euo pipefail
trap 'exit 124' TERM INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/render-fixture.sh"

# State 1: trust prompt を表示
render_fixture "write-create-new-file.txt"

# State 2: キー入力待ち（30 秒タイムアウト）
read -rsn1 -t 30 key || exit 124

case "$key" in
  "1")
    # Yes: 作成成功
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Created .claude/agents/test-agent.md"
    echo ""
    echo "  ? for shortcuts"
    echo ""
    # 成功後はアイドル状態で待機（テストが capture できるようにする）
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "2")
    # Yes, and allow for session
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Created .claude/agents/test-agent.md (session-allowed)"
    echo ""
    echo "  ? for shortcuts"
    echo ""
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "3")
    # No
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  User rejected the request."
    echo ""
    exit 1
    ;;
  *)
    echo "Unknown key: $key" >&2
    exit 2
    ;;
esac
