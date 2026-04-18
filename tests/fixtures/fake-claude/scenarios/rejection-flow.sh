#!/bin/bash
# scenarios/rejection-flow.sh
# Scenario: Rejection-only flow for verifying exit-on-No behavior
#
# Uses the write-create prompt fixture as the base prompt.
# Any non-"3" key produces an error exit; "3" triggers the rejection message
# and exits with code 1 (matching Claude's behavior when the user rejects).
#
# State transitions:
#   State 1: Display fixture "write-create-new-file.txt"
#   Input "3" -> No: rejection message -> exit 1
#   Other    -> Unknown key -> exit 2

set -euo pipefail
trap 'exit 124' TERM INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/render-fixture.sh"

# State 1: display a Write-type prompt
render_fixture "write-create-new-file.txt"

# State 2: wait for key input (30-second timeout)
read -rsn1 -t 30 key || exit 124

case "$key" in
  "3")
    # No: reject and exit
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  User rejected the request."
    echo ""
    exit 1
    ;;
  *)
    echo "Unexpected key for rejection-flow: $key" >&2
    exit 2
    ;;
esac
