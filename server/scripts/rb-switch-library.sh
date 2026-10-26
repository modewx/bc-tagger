#!/usr/bin/env bash
# Swap which library the rekordbox app opens: the bc-tagger TEST library or your MAIN one.
#
#   rb-switch-library.sh status   show which library is active
#   rb-switch-library.sh test     make rekordbox open the test library
#   rb-switch-library.sh main     switch back to the main library
#
# USER-RUN ONLY. Automated tools (and Claude sessions) never run this script.
#
# rekordbox always opens ~/Library/Pioneer/rekordbox/master.db (options.json "db-path"),
# so this swaps folders by rename, which is atomic and copies nothing:
#
#   main active:  rekordbox/        = main      rekordbox_test/ = test (has the marker)
#   test active:  rekordbox/        = test      rekordbox_main/ = main
#
# It refuses while rekordbox is running and checks the marker file
# (.bc-tagger-test-library) so the main library can never be mistaken for the test one.
# While the test library is active, bc-tagger exports refuse to write (the test DB is not
# at ~/Library/Pioneer/rekordbox_test any more), so switch back to "main" before exporting.

set -euo pipefail

PIONEER="${HOME}/Library/Pioneer"
ACTIVE="${PIONEER}/rekordbox"
TEST="${PIONEER}/rekordbox_test"
MAIN_PARKED="${PIONEER}/rekordbox_main"
MARKER=".bc-tagger-test-library"

die() { echo "error: $*" >&2; exit 1; }

has_marker() { [[ -f "$1/${MARKER}" ]]; }

rekordbox_running() { pgrep -x rekordbox >/dev/null 2>&1; }

state() {
  if [[ -d "$ACTIVE" ]] && ! has_marker "$ACTIVE" && [[ -d "$TEST" ]] && has_marker "$TEST" && [[ ! -e "$MAIN_PARKED" ]]; then
    echo main
  elif [[ -d "$ACTIVE" ]] && has_marker "$ACTIVE" && [[ -d "$MAIN_PARKED" ]] && ! has_marker "$MAIN_PARKED" && [[ ! -e "$TEST" ]]; then
    echo test
  else
    echo unknown
  fi
}

require_closed() {
  if rekordbox_running; then
    die "rekordbox is running. Quit it first (File > Exit), then run this again."
  fi
  if pgrep -x rekordboxAgent >/dev/null 2>&1; then
    echo "note: rekordboxAgent is running in the background; that's fine (the rename keeps its open files valid)."
  fi
}

cmd="${1:-status}"
current="$(state)"

case "$cmd" in
  status)
    echo "active library: ${current}"
    [[ "$current" == unknown ]] && {
      echo "  folders: $(ls -d "${PIONEER}"/rekordbox* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
      echo "  expected either rekordbox/ + rekordbox_test/ (main) or rekordbox/ + rekordbox_main/ (test)"
    }
    if rekordbox_running; then echo "rekordbox: running"; else echo "rekordbox: not running"; fi
    ;;
  test)
    [[ "$current" == test ]] && { echo "test library is already active"; exit 0; }
    [[ "$current" == main ]] || die "unexpected folder layout (state: ${current}); run 'status' and fix it by hand"
    require_closed
    mv "$ACTIVE" "$MAIN_PARKED"
    mv "$TEST" "$ACTIVE"
    echo "switched: rekordbox will now open the TEST library. Run '$0 main' to switch back."
    ;;
  main)
    [[ "$current" == main ]] && { echo "main library is already active"; exit 0; }
    [[ "$current" == test ]] || die "unexpected folder layout (state: ${current}); run 'status' and fix it by hand"
    require_closed
    mv "$ACTIVE" "$TEST"
    mv "$MAIN_PARKED" "$ACTIVE"
    echo "switched: rekordbox will now open your MAIN library."
    ;;
  *)
    echo "usage: $0 {status|test|main}" >&2
    exit 2
    ;;
esac
