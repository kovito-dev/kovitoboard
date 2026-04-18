#!/bin/bash
# scenarios/edit-modify.sh
# Scenario: Edit tool (Update) on an existing file -> approval or rejection
#
# State transitions:
#   State 1: Display fixture "edit-modify-existing.txt" (Edit prompt)
#   Input "1" -> Yes: show "edit applied" message
#   Input "2" -> No: show "rejected" message -> exit 1
#   Other    -> Unknown key -> exit 2

set -euo pipefail
trap 'exit 124' TERM INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/render-fixture.sh"

# State 1: display the Edit prompt
render_fixture "edit-modify-existing.txt"

# State 2: wait for key input (30-second timeout)
read -rsn1 -t 30 key || exit 124

case "$key" in
  "1")
    # Yes: apply edit
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Applied edit to sample.txt"
    echo ""
    echo "  ? for shortcuts"
    echo ""
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "2")
    # No: reject edit
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  User rejected the edit."
    echo ""
    exit 1
    ;;
  *)
    echo "Unknown key: $key" >&2
    exit 2
    ;;
esac
