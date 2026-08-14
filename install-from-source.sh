#!/bin/sh
# hx-fortress — build-from-source installer + enroll entrypoint.
# Params are optional: the cloud URL defaults to production (let.ai), and an empty
# token triggers the interactive key-acquisition flow (browser or paste) at enroll.
set -eu

INSTALL_DIR="${HOME}/.let/bin"
BIN="${INSTALL_DIR}/hx-fortress"
DEFAULT_CLOUD_URL="wss://let.ai/_api/hx-gateway/vault-tunnel"

usage() { echo "usage: ./hx-fortress/install-from-source.sh [token] [--cloud <url>]" >&2; exit 2; }

TOKEN=""
CLOUD_URL="$DEFAULT_CLOUD_URL"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cloud) [ "$#" -ge 2 ] || usage; CLOUD_URL="$2"; shift 2 ;;
    --) shift ;;
    -*) echo "hx-fortress: unknown option: $1" >&2; usage ;;
    *) [ -z "$TOKEN" ] || usage; TOKEN="$1"; shift ;;
  esac
done

# --- require Bun (offer to install) -----------------------------------
if ! command -v bun >/dev/null 2>&1; then
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

# --- install ----------------------------------------------------------
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/dist/hx-fortress" "$BIN"
[ "$(uname -s)" = "Darwin" ] && codesign --force --sign - "$BIN"
echo "Installed hx-fortress to $BIN"

# --- enroll (empty token → key-acquisition flow) ----------------------
if (: </dev/tty) 2>/dev/null; then
  exec "$BIN" enroll ${TOKEN:+"$TOKEN"} --cloud "$CLOUD_URL" </dev/tty
else
  exec "$BIN" enroll ${TOKEN:+"$TOKEN"} --cloud "$CLOUD_URL"
fi
