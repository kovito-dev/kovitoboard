#!/bin/bash
# scenarios/edit-modify.sh
# Scenario: Edit tool (Update) on an existing file -> approval / session / rejection
#
# The fixture edit-modify-existing.txt shows three choices (Yes / Yes-session / No),
# matching trust-patterns.json's edit-update-existing definition. The detector
# sends "1\n" / "2\n" / "3\n" for these choices.
#
# State transitions:
#   State 1: Display fixture "edit-modify-existing.txt" (Edit prompt)
#   Input "1" -> Yes: show "edit applied" message
#   Input "2" -> Yes, and allow for session: session-allowed message
#   Input "3" -> No: rejection message -> exit 1
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
    # Yes, and allow all edits during this session
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Applied edit to sample.txt (session-allowed)"
    echo ""
    echo "  ? for shortcuts"
    echo ""
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "3")
    # No: reject edit
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  User rejected the edit."
    echo ""
    sleep 1
    exit 1
    ;;
  *)
    echo "Unknown key: $key" >&2
    exit 2
    ;;
esac
