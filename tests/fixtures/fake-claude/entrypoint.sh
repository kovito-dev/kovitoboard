#!/bin/bash
# entrypoint.sh — Fake Claude 共通エントリポイント
#
# Usage: bash entrypoint.sh <scenario-name>
#
# シナリオ名を引数で受け取り、対応する scenarios/<name>.sh を実行する。
# tmux window 内で実行されることを前提とする。

set -euo pipefail
trap 'exit 124' TERM INT

SCENARIO_NAME="${1:?Usage: entrypoint.sh <scenario-name>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO_SCRIPT="$SCRIPT_DIR/scenarios/${SCENARIO_NAME}.sh"

if [ ! -f "$SCENARIO_SCRIPT" ]; then
  echo "Unknown scenario: $SCENARIO_NAME" >&2
  echo "Available scenarios:" >&2
  ls "$SCRIPT_DIR/scenarios/"*.sh 2>/dev/null | xargs -n1 basename | sed 's/\.sh$//' >&2
  exit 2
fi

exec bash "$SCENARIO_SCRIPT"
