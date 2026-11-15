#!/usr/bin/env bash
# Builds the data runner: the program an HX Fortress starts beside itself to do
# one job on a database. Its source is the folder data-runner/, a Go module of
# its own, which nothing in this repository edits.
#
#   scripts/build-data-runner.sh <out-dir> [version] [os/arch ...]
#
# Writes <out-dir>/hx-fortress-data-runner-<os>-<arch>, one file for each
# target. With no target it builds the four platforms HX Fortress is released
# for. <arch> is written as HX Fortress's own binaries write it: arm64, and x64
# for Go's amd64. [version] is what `data-runner version` prints. With none it
# prints "dev".
#
# The release, the dev build, CI and the image all build the program with this
# script, so a release runs no build command that a pull request did not run.
#
# WHAT IS BUILT IS WHAT THE FOLDER'S LIST NAMES, AND NOTHING ELSE. The script
# copies the files that data-runner/FILES.sha256 names into an empty folder,
# checks every copy against its checksum, and builds there. A file that was
# added to data-runner/, a link, or the result of an earlier build is never
# compiled, and a listed file that differs stops the build.
#
# It needs Go on the PATH. It builds with the version of Go that
# data-runner/go.mod names, whichever version is installed: Go fetches that
# toolchain itself when the installed one is another.
set -euo pipefail

# The same answers in every shell and on every machine: patterns and sorting
# go byte by byte, and `cd` goes only where it is told (a caller's CDPATH would
# send a relative path somewhere else, and print it).
export LC_ALL=C
unset CDPATH

usage() {
  echo "usage: scripts/build-data-runner.sh <out-dir> [version] [os/arch ...]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
out_dir="$1"
shift

version="dev"
if [ "$#" -ge 1 ]; then
  version="$1"
  shift
fi
# The version becomes part of a linker flag. With no space and no quote in it,
# it cannot add a flag of its own.
case "$version" in
  "" | *[!A-Za-z0-9._+-]*)
    echo "build-data-runner: a version holds letters, digits, '.', '_', '+' and '-' only" >&2
    exit 2
    ;;
esac

if [ "$#" -eq 0 ]; then
  set -- darwin/arm64 darwin/amd64 linux/arm64 linux/amd64
fi
for target in "$@"; do
  case "$target" in
    darwin/arm64 | darwin/amd64 | linux/arm64 | linux/amd64) ;;
    *)
      echo "build-data-runner: HX Fortress is not released for the platform ${target}" >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

# ── A clean copy of the listed files ─────────────────────────────────────────
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$root/data-runner"
cp FILES.sha256 "$work/FILES.sha256"
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  # A line is a checksum, a space, a space or a star, and a path.
  if ! [[ "$line" =~ ^[0-9a-f]{64}\ [\ *](.+)$ ]]; then
    echo "build-data-runner: a line of data-runner/FILES.sha256 is not a checksum and a path" >&2
    exit 1
  fi
  name="${BASH_REMATCH[1]}"
  # A path of the list stays inside the folder.
  case "/${name}/" in
    //* | */../* | */./*)
      echo "build-data-runner: data-runner/FILES.sha256 names a path outside the folder" >&2
      exit 1
      ;;
  esac
  case "$name" in
    */*) [ -d "$work/${name%/*}" ] || mkdir -p "$work/${name%/*}" ;;
  esac
  # `./` in front: a name that starts with a dash is a file, never an option.
  cp "./$name" "$work/$name"
done < FILES.sha256

cd "$work"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check --strict --quiet FILES.sha256
else
  shasum -a 256 --check --strict --quiet FILES.sha256
fi

# ── The version of Go ────────────────────────────────────────────────────────
# The module says which Go builds it: its `toolchain` line when it has one,
# else its `go` line. A full version (1.27.3) names one toolchain, and the
# build is held to it. A line with no patch number (1.27) names a language
# version only, and then the installed Go builds.
go_version="$(sed -n 's/^toolchain go\([0-9][0-9.]*\)$/\1/p' go.mod | head -n 1)"
if [ -z "$go_version" ]; then
  go_version="$(sed -n 's/^go \([0-9][0-9.]*\)$/\1/p' go.mod | head -n 1)"
fi
if [ -z "$go_version" ]; then
  echo "build-data-runner: data-runner/go.mod names no version of Go" >&2
  exit 1
fi
case "$go_version" in
  *.*.*) export GOTOOLCHAIN="go${go_version}" ;;
esac

# The module's own list of dependencies is read and never rewritten, so a
# module that go.sum does not hold stops the build. No workspace file of a
# folder above is taken.
export GOFLAGS="-mod=readonly"
export GOWORK="off"
# Nothing of the caller's own Go settings changes what is built: not the file
# that `go env -w` writes, not an experiment, not a processor level above the
# one every machine of a platform has.
export GOENV="off"
export GOEXPERIMENT=""
export GOFIPS140="off"
export GOARM64="v8.0"

# ── The build ────────────────────────────────────────────────────────────────
for target in "$@"; do
  os="${target%/*}"
  goarch="${target#*/}"
  arch="$goarch"
  if [ "$goarch" = "amd64" ]; then
    arch="x64"
  fi
  name="hx-fortress-data-runner-${os}-${arch}"
  echo "build-data-runner: ${name}, with Go ${go_version}" >&2
  # CGO_ENABLED=0: no C code is compiled in. The linux files are static and
  # need no C library of the host. The darwin files use the system's own
  # library, as every program for macOS does.
  # GOAMD64=v1: runs on every x86-64 processor, as HX Fortress's own x64 build
  # does. -trimpath and -buildvcs=false: the file does not depend on the folder
  # it was built in, or on whether git is there to ask.
  GOOS="$os" GOARCH="$goarch" GOAMD64="v1" CGO_ENABLED="0" \
    go build -trimpath -buildvcs=false \
    -ldflags "-s -w -X main.version=${version}" \
    -o "${out_dir}/${name}" .
done
