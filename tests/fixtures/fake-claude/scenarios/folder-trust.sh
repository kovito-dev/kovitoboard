#!/bin/bash
# scenarios/folder-trust.sh
# Scenario: Initial folder trust prompt -> approval or exit
#
# State transitions:
#   State 1: Display fixture "folder-trust-initial.txt" (trust prompt)
#   Input "1" -> Yes: show "Welcome back" ready state
#   Input "2" -> No: exit (simulates user cancelling)
#   Other    -> Unknown key -> exit 2

set -euo pipefail
trap 'exit 124' TERM INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/render-fixture.sh"

# State 1: display the folder trust prompt
render_fixture "folder-trust-initial.txt"

# State 2: wait for key input (30-second timeout)
# In raw mode, pressing Enter yields an empty string (bash read behaviour).
# The KB detector sends "Enter" for the Yes choice on folder-trust prompts,
# so we accept both "1" and empty (Enter) as Yes.
read -rsn1 -t 30 key || exit 124

case "$key" in
  "1"|"")
    # Yes: trust accepted, proceed to ready state
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Welcome back, session ready."
    echo ""
    echo "  ? for shortcuts"
    echo ""
    # Idle wait so tests can capture post-state
    while true; do read -rsn1 -t 30 || exit 124; done
    ;;
  "2")
    # No: user declined, exit with error
    printf '\033[3J\033[H\033[2J'
    echo ""
    echo "  Folder not trusted. Exiting."
    echo ""
    sleep 1
    exit 1
    ;;
  *)
    echo "Unknown key: $key" >&2
    exit 2
    ;;
esac
