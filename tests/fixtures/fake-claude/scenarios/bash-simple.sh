#!/bin/bash
# scenarios/bash-simple.sh
# Scenario: Bash tool (touch) prompt -> approval, session-allow, or rejection
#
# State transitions:
#   State 1: Display fixture "bash-touch-command.txt" (Bash prompt)
#   Input "1" -> Yes: execute and show completion message
#   Input "2" -> Yes, and always allow: session-allowed completion
#   Input "3" -> No: rejection message -> exit 1
#   Other    -> Unknown key -> exit 2

set -euo pipefail
trap 'exit 124' TERM INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/render-fixture.sh"

# State 1: display the Bash prompt
render_fixture "bash-touch-command.txt"

# State 2: wait for key input (30-second timeout)
read -rsn1 -t 30 key || exit 124

case "$key" in
  "1")
    # Yes: run command
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Ran: touch newfile.txt"
    echo ""
    echo "  ? for shortcuts"
    echo ""
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "2")
    # Yes, and always allow
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Ran: touch newfile.txt (session-allowed)"
    echo ""
    echo "  ? for shortcuts"
    echo ""
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "3")
    # No: reject
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  User rejected the Bash command."
    echo ""
    exit 1
    ;;
  *)
    echo "Unknown key: $key" >&2
    exit 2
    ;;
esac
