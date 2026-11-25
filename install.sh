#!/bin/sh
# The install script of HX Fortress.
#
# It downloads the program from the project's releases, checks the download
# against the checksum published beside it, and puts the program on this
# computer. Then it runs `hx-fortress install`, which serves the setup in your
# browser, on this computer only, and makes HX Fortress in the place you pick.
# The script asks for nothing itself, and it reaches one address: the one the
# files come from.
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/HX-Framework/hx-fortress/releases/latest/download/hx-fortress-install.sh | sh
#
# Options follow `sh -s --`:
#
#   curl --proto '=https' --tlsv1.2 -fsSL <the same address> | sh -s -- --on-this-machine
#
#   --from <address>    A base address that holds one release's files, in
#                       place of the project's releases. Also HX_FORTRESS_FROM.
#   --dir <folder>      Where the program goes. Also HX_FORTRESS_BIN_DIR.
#   --on-this-machine   Run `hx-fortress setup` in place of `hx-fortress
#                       install`: HX Fortress then runs on this machine.
#   --program-only      Put the program in place, and run nothing.
#
# Every other option goes to the command this script runs, as it is written.
# That is how the command a control plane shows names that control plane:
# `--connect <address>/i/<id> --pages <origin>`. Such an option is checked
# against the options that command takes before anything is downloaded, and
# the program that was downloaded is asked for its commands before it replaces
# the one on this computer. So a mistyped option, or a release from before the
# command existed, leaves this computer as it was.
#
# A program that is already on this computer, and can say its version, is not
# replaced by an older one: HX Fortress may be running from it, on a database
# a newer version has already changed. The script asks it `hx-fortress
# version`, and the address has to say which version it holds, as it has to
# for `hx-fortress update`. A program from before that command says nothing,
# so nothing can be compared, and the script replaces it.
#
# What the check proves: the checksum shows that the bytes arrived whole. It
# does not show who made them, because it comes from the same place as the
# program. `hx-fortress update` checks a release's signature when the release
# has one.
set -eu

PROJECT_RELEASES="https://github.com/HX-Framework/hx-fortress/releases/latest/download"
FROM="${HX_FORTRESS_FROM:-$PROJECT_RELEASES}"
# The default folder is worked out after the options are read: with --dir, a
# computer that has no HOME needs none.
BIN_DIR="${HX_FORTRESS_BIN_DIR:-}"
# The command of the program that this script runs at its end, or `none`.
THEN=install

# The options the two commands take: the ones that stand alone, and the ones
# that take a value. They are the program's own lists (src/cli-install.ts,
# src/cli-setup.ts), and a test holds these lines to them.
INSTALL_FLAGS="--terminal --no-open --list"
INSTALL_VALUES="--file --connect --pages --port"
SETUP_FLAGS="--browser --from-environment --print --list --no-container --starts-after"
SETUP_VALUES="--file --connect --pages --port --url"

say() { printf '%s\n' "$*"; }
fail() { printf 'hx-fortress: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'usage: hx-fortress-install.sh [--from <address>] [--dir <folder>] [--on-this-machine | --program-only]\n' >&2
  printf '       Every other option goes to the command it runs: hx-fortress install, or hx-fortress setup.\n' >&2
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
# a_version <text>: true when the text is three numbers with dots, as 1.2.3.
a_version() {
  case "$1" in
    *[!0-9.]*|.*|*.|*..*|"") return 1 ;;
  esac
  case "$1" in
    *.*.*.*) return 1 ;;
    *.*.*) return 0 ;;
  esac
  return 1
}
# older_than <a> <b>: true when version a is older than version b. Both are
# three numbers with dots.
older_than() {
  rest_a="$1"
  rest_b="$2"
  for part in 1 2 3; do
    number_a="${rest_a%%.*}"
    number_b="${rest_b%%.*}"
    [ "$number_a" -lt "$number_b" ] && return 0
    [ "$number_a" -gt "$number_b" ] && return 1
    rest_a="${rest_a#*.}"
    rest_b="${rest_b#*.}"
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
        --*) fail "the option ${wants} needs a value after it. Nothing was downloaded." ;;
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
      printf '             This script takes: --from <address>, --dir <folder>, --on-this-machine, --program-only.\n' >&2
      printf '             hx-fortress %s takes: %s.\n' "$to" "$flags $values" >&2
      printf '             Nothing was downloaded.\n' >&2
      exit 2
    fi
  done
  [ -z "$wants" ] || fail "the option ${wants} needs a value after it. Nothing was downloaded."
}

# Each option is looked at once. One that is not this script's own is put back
# at the end of the list, so what is left after the loop is what the program's
# command gets, in the order it was written.
left=$#
while [ "$left" -gt 0 ]; do
  option="$1"
  shift
  left=$((left - 1))
  case "$option" in
    --from)
      [ "$left" -ge 1 ] || usage
      FROM="$1"
      shift
      left=$((left - 1))
      ;;
    --dir)
      [ "$left" -ge 1 ] || usage
      [ -n "$1" ] || fail "the folder for the program is empty"
      BIN_DIR="$1"
      shift
      left=$((left - 1))
      ;;
    --on-this-machine) [ "$THEN" = install ] || usage; THEN=setup ;;
    --program-only) [ "$THEN" = install ] || usage; THEN=none ;;
    -h|--help) usage ;;
    # `sh -s --` ends the shell's own options. One more is not an option of
    # anything, and is left out.
    --) ;;
    *) set -- "$@" "$option" ;;
  esac
done
# What is left goes to the command, and it is checked here, before anything is
# downloaded. With nothing to run, an option has nowhere to go.
case "$THEN" in
  none)
    if [ "$#" -gt 0 ]; then
      printf 'hx-fortress: --program-only runs nothing, so it takes no option for a command\n' >&2
      usage
    fi
    ;;
  install) passes_on install "$INSTALL_FLAGS" "$INSTALL_VALUES" "$@" ;;
  setup) passes_on setup "$SETUP_FLAGS" "$SETUP_VALUES" "$@" ;;
esac
if [ -z "$BIN_DIR" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is not set, so there is no folder to put the program in. Name one with --dir."
  BIN_DIR="${HOME}/.let/bin"
fi

FROM="${FROM%/}"
# A plain address. With a user name in it, an address that starts like this
# computer's own would be another host's: http://127.0.0.1:80@files.example/.
case "$FROM" in
  *[@?#]*) fail "the address to download from must be a plain address: no user name, no password, no \"?\" and no \"#\"" ;;
esac
# https, or this computer itself.
case "$FROM" in
  https://?*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) ;;
  http://localhost|http://localhost:*|http://localhost/*) ;;
  http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*) ;;
  *) fail "the address to download from must start with https://" ;;
esac

# --- which program fits this computer ------------------------------------
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this script runs on macOS and Linux. For another system, use the container image or build from the source." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac
asset="hx-fortress-${os}-${arch}"

command -v curl >/dev/null 2>&1 || fail "curl is needed to download the program"
command -v gzip >/dev/null 2>&1 || fail "gzip is needed to unpack the program"
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is needed to check the download"
fi

# --- download and check --------------------------------------------------
# An https address is asked over https only. An address on this computer
# itself may be http: that one request is in clear text, and it leaves no
# network. A redirect from either is followed only to https: the project's
# releases answer a file's address with a redirect to the host that stores the
# file. So nothing an address answers makes this script ask another host in
# clear text.
case "$FROM" in
  https://*) protocols="--proto =https --proto-redir =https --tlsv1.2" ;;
  *) protocols="--proto =http,https --proto-redir =https" ;;
esac
# download <address> <file> <seconds>: with a deadline, and tried again when
# the network fails for a moment.
download() {
  # The words of protocols are options, so they are split on purpose.
  # shellcheck disable=SC2086
  curl -fsSL $protocols --retry 3 --connect-timeout 20 --max-time "$3" "$1" -o "$2"
}

work="$(mktemp -d)"
# The new copy of the program, while it is not yet in place.
NEW=""
# Whatever this script made and did not finish goes whenever the script ends,
# and a signal ends the script: without the second line, a shell would run the
# first and go on.
trap 'rm -rf "$work"; [ -z "$NEW" ] || rm -f "$NEW"' EXIT
trap 'exit 130' INT TERM

say "Downloading ${asset} from ${FROM}"
download "${FROM}/${asset}.gz" "${work}/program.gz" 900 \
  || fail "could not download ${FROM}/${asset}.gz"
download "${FROM}/${asset}.sha256" "${work}/program.sha256" 60 \
  || fail "could not download ${FROM}/${asset}.sha256"
gzip -dc "${work}/program.gz" > "${work}/program" || fail "the download is not a gzip file"

expected="$(awk 'NR==1 {print tolower($1)}' "${work}/program.sha256")"
case "$expected" in
  *[!0-9a-f]*|"") fail "the published checksum is not a sha256" ;;
esac
[ "${#expected}" -eq 64 ] || fail "the published checksum is not a sha256"
actual="$(sha256_of "${work}/program")"
if [ "$actual" != "$expected" ]; then
  fail "the download does not match its checksum (expected ${expected}, got ${actual}). Nothing was put in place."
fi

# --- never an older program over a newer one -------------------------------
BIN="${BIN_DIR}/hx-fortress"
# What the address says about its version. It is asked here, before anything
# is put in place, only when a program is already on this computer: the two
# versions are then compared. Otherwise it is asked last, for one printed line.
version=""
asked_version=no
if [ -x "$BIN" ]; then
  # A program from before the `version` command answers with its help, which
  # is no version: then nothing is known, nothing is compared, and it is
  # replaced.
  have="$("$BIN" version 2>/dev/null | head -n 1 | tr -cd '0-9A-Za-z.+-' || true)"
  version="$(download "${FROM}/hx-fortress-version" - 10 2>/dev/null | head -n 1 | tr -cd '0-9A-Za-z.+-' || true)"
  asked_version=yes
  if a_version "$have"; then
    # The program here says its version, so this run updates it, and it is
    # held to the rule of `hx-fortress update`: the address has to say which
    # version it holds, and that version must not be an older one.
    a_version "$version" \
      || fail "the program at ${BIN} is version ${have}, and ${FROM}/hx-fortress-version does not state a version such as 1.2.3, so it cannot be told whether this would go back to an older one. Nothing was put in place. To put it in place all the same, remove ${BIN} first."
    if older_than "$version" "$have"; then
      fail "the program at ${BIN} is version ${have}, and ${FROM} holds the older version ${version}. Nothing was put in place. To put the older one in place all the same, remove ${BIN} first."
    fi
  fi
fi

# --- put it in place -----------------------------------------------------
mkdir -p "$BIN_DIR"
# Into the same folder first, then renamed: a program that is running keeps the
# file it started from, and nothing ever sees half a program.
NEW="${BIN}.new.$$"
cp "${work}/program" "$NEW"
chmod 755 "$NEW"
if [ "$os" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
  # macOS on Apple silicon runs only signed programs. This signature names
  # nobody: it is made here, on this Mac, for this copy.
  codesign --force --sign - "$NEW" >/dev/null 2>&1 \
    || say "warning: could not sign the program for this Mac. If macOS refuses to run it, run: codesign --force --sign - ${BIN}"
fi
if [ "$THEN" != none ]; then
  # The new copy is asked for its commands BEFORE it replaces the program that
  # is here. A copy that does not run on this computer, or a release from
  # before the command existed, then changes nothing.
  commands="$("$NEW" help 2>/dev/null)" \
    || fail "the program that was downloaded could not be run on this computer. Nothing was put in place."
  printf '%s\n' "$commands" | grep -Eq "hx-fortress ${THEN}( |\$)" \
    || fail "the version at ${FROM} has no '${THEN}' command. Nothing was put in place. To put that version in place and run nothing: --program-only"
fi
mv -f "$NEW" "$BIN"
NEW=""

# For the line below only, so it is asked last, briefly, and its failure
# changes nothing.
if [ "$asked_version" = no ]; then
  version="$(download "${FROM}/hx-fortress-version" - 10 2>/dev/null | head -n 1 | tr -cd '0-9A-Za-z.+-' || true)"
fi

# The folder of the download is not needed any more. It is removed here,
# because a shell that hands over to the program runs no trap.
rm -rf "$work"
trap - EXIT INT TERM

say "The program hx-fortress${version:+ ${version}} is at ${BIN}"
say "Checksum ${actual}"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) say "${BIN_DIR} is not on your PATH. Add it, or call the program by its full name." ;;
esac

# --- what comes next -----------------------------------------------------
if [ "$THEN" = none ]; then
  say "To make HX Fortress in a cloud account or on a machine with Docker: ${BIN} install"
  say "To set it up on this machine: ${BIN} setup"
  exit 0
fi
exec "$BIN" "$THEN" "$@"
