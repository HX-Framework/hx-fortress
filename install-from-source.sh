#!/bin/sh
# HX Fortress: build the program from this checkout and put it on this
# computer.
#
#   ./install-from-source.sh
#   ./install-from-source.sh --on-this-machine
#   ./install-from-source.sh --program-only
#   ./install-from-source.sh --cloud <the control plane's address> [token]
#
# It builds the program with Bun, which it offers to install when it is
# missing, and puts the result in ~/.let/bin/hx-fortress. It downloads nothing
# but the build's own dependencies. Then it does what the install script of a
# release does (install.sh): it runs `hx-fortress install`, which serves the
# setup in your browser, on this computer only.
#
#   --dir <folder>      Where the program goes. Also HX_FORTRESS_BIN_DIR.
#   --on-this-machine   Run `hx-fortress setup` in place of `hx-fortress
#                       install`: HX Fortress then runs on this machine.
#   --program-only      Put the program in place, and run nothing.
#   --cloud <address> [token]
#                       Enroll with that control plane, the way an earlier
#                       version did: with the token when one is given, and by
#                       a sign-in in the browser when none is.
#
# Every other option goes to the command this script runs, as it is written:
# `--connect <address>/i/<id> --pages <origin>`, for one. Such an option is
# checked against the options that command takes before anything is built.
#
# No address of any control plane is written here. HX Fortress runs with none,
# and the address is always the one a person gives.
set -eu

# The default folder is worked out after the options are read: with --dir, a
# computer that has no HOME needs none.
INSTALL_DIR="${HX_FORTRESS_BIN_DIR:-}"
# The command of the program that this script runs at its end, or `none`.
THEN=install

# The options the two commands take: the ones that stand alone, and the ones
# that take a value. They are the program's own lists (src/cli-install.ts,
# src/cli-setup.ts) and the same lines as in install.sh: a test holds all
# three together.
INSTALL_FLAGS="--terminal --no-open --list"
INSTALL_VALUES="--file --connect --pages --port"
SETUP_FLAGS="--browser --from-environment --print --list --no-container --starts-after"
SETUP_VALUES="--file --connect --pages --port --url"

fail() { printf 'hx-fortress: %s\n' "$*" >&2; exit 1; }
usage() {
  echo "usage: ./install-from-source.sh [--dir <folder>] [--on-this-machine | --program-only | --cloud <the control plane's address> [token]]" >&2
  echo "       Every other option goes to the command it runs: hx-fortress install, or hx-fortress setup." >&2
  exit 2
}
# is_in <word> <list…>: true when the word is one of the list.
is_in() {
  needle="$1"
  shift
  for candidate in "$@"; do
    [ "$needle" = "$candidate" ] && return 0
  done
  return 1
}
# passes_on <command> <flags> <values> <words…>: ends the script, in words,
# when a word is not an option that command takes.
passes_on() {
  to="$1"
  flags="$2"
  values="$3"
  shift 3
  wants=""
  for word in "$@"; do
    if [ -n "$wants" ]; then
      case "$word" in
        --*) fail "the option ${wants} needs a value after it. Nothing was built." ;;
      esac
      wants=""
      continue
    fi
    # The lists hold plain words, so they are split on purpose.
    # shellcheck disable=SC2086
    if is_in "$word" $values; then
      wants="$word"
    elif is_in "$word" $flags; then
      :
    else
      printf 'hx-fortress: "%s" is not an option of this script, and hx-fortress %s does not take it either.\n' "$word" "$to" >&2
      printf '             This script takes: --dir <folder>, --on-this-machine, --program-only, --cloud <address> [token].\n' >&2
      printf '             hx-fortress %s takes: %s.\n' "$to" "$flags $values" >&2
      printf '             Nothing was built.\n' >&2
      exit 2
    fi
  done
  [ -z "$wants" ] || fail "the option ${wants} needs a value after it. Nothing was built."
}

CLOUD_URL=""
# Each option is looked at once. One that is not this script's own is put back
# at the end of the list, so what is left after the loop is what the program's
# command gets, in the order it was written.
left=$#
while [ "$left" -gt 0 ]; do
  option="$1"
  shift
  left=$((left - 1))
  case "$option" in
    --cloud)
      [ "$left" -ge 1 ] || usage
      [ "$THEN" = install ] || usage
      CLOUD_URL="$1"
      THEN=enroll
      shift
      left=$((left - 1))
      ;;
    --dir)
      [ "$left" -ge 1 ] || usage
      [ -n "$1" ] || fail "the folder for the program is empty"
      INSTALL_DIR="$1"
      shift
      left=$((left - 1))
      ;;
    --on-this-machine) [ "$THEN" = install ] || usage; THEN=setup ;;
    --program-only) [ "$THEN" = install ] || usage; THEN=none ;;
    -h|--help) usage ;;
    # Not an option of anything, so it is left out.
    --) ;;
    *) set -- "$@" "$option" ;;
  esac
done
# Checked before anything is built: an option that has nowhere to go, an
# option the command does not take, and an enrollment that is given more than
# its one token.
case "$THEN" in
  none)
    if [ "$#" -gt 0 ]; then
      echo "hx-fortress: --program-only runs nothing, so it takes no option for a command" >&2
      usage
    fi
    ;;
  enroll)
    [ -n "$CLOUD_URL" ] || usage
    [ "$#" -le 1 ] || usage
    case "${1:-}" in
      -*) echo "hx-fortress: --cloud takes the address, and then at most a token" >&2; usage ;;
    esac
    ;;
  install) passes_on install "$INSTALL_FLAGS" "$INSTALL_VALUES" "$@" ;;
  setup) passes_on setup "$SETUP_FLAGS" "$SETUP_VALUES" "$@" ;;
esac
if [ -z "$INSTALL_DIR" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is not set, so there is no folder to put the program in. Name one with --dir."
  INSTALL_DIR="${HOME}/.let/bin"
fi
BIN="${INSTALL_DIR}/hx-fortress"

# --- require Bun (offer to install) -----------------------------------
if ! command -v bun >/dev/null 2>&1; then
  # Bun's own installer puts Bun under HOME, so this is said before the
  # question is asked, and not as a shell's complaint after the answer.
  [ -n "${HOME:-}" ] \
    || fail "Bun is needed to build from the source, and it is not on this computer. Its installer needs HOME, which is not set. Install Bun (https://bun.sh) or set HOME, and run this again."
  printf "Bun is required to build from source. Install Bun now? (Y/n) " >&2
  read ans </dev/tty || ans=""
  case "$ans" in
    [nN]*) echo "Install Bun then re-run:  curl -fsSL https://bun.sh/install | bash" >&2; exit 1 ;;
    *)
      curl -fsSL https://bun.sh/install | bash
      # The installer edits shell rc, NOT this process — add bun to PATH now.
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      command -v bun >/dev/null 2>&1 || { echo "hx-fortress: Bun install failed." >&2; exit 1; }
      ;;
  esac
fi

# --- build ------------------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
echo "Installing dependencies…"; bun install
echo "Building hx-fortress…";   bun run build

# --- put it in place --------------------------------------------------
mkdir -p "$INSTALL_DIR"
# Into the same folder first, then renamed: a program that is running keeps the
# file it started from, and nothing ever sees half a program.
NEW="${BIN}.new.$$"
trap '[ -z "$NEW" ] || rm -f "$NEW"' EXIT
trap 'exit 130' INT TERM
cp "$SCRIPT_DIR/dist/hx-fortress" "$NEW"
chmod 755 "$NEW"
if [ "$(uname -s)" = "Darwin" ]; then codesign --force --sign - "$NEW"; fi
mv -f "$NEW" "$BIN"
NEW=""
trap - EXIT INT TERM
echo "The program hx-fortress is at $BIN"

# --- what comes next --------------------------------------------------
if [ "$THEN" = none ]; then
  echo "To make HX Fortress in a cloud account or on a machine with Docker: $BIN install"
  echo "To set it up on this machine: $BIN setup"
  exit 0
fi
if [ "$THEN" = enroll ]; then
  # The sign-in reads its answers from the terminal, not from whatever this
  # script's own input is. With no token it starts the sign-in in the browser.
  if (: </dev/tty) 2>/dev/null; then
    exec "$BIN" enroll "$@" --cloud "$CLOUD_URL" </dev/tty
  fi
  exec "$BIN" enroll "$@" --cloud "$CLOUD_URL"
fi
exec "$BIN" "$THEN" "$@"
