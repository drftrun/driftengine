#!/usr/bin/env bash
#
# Build the macOS artifacts on a Mac.
#
# **This is not the only route any more.** A Mac target cross-builds from Linux, where the packager
# ad-hoc signs it with rcodesign and archives it with `zip -y`. What that route cannot produce is a
# .dmg — hdiutil is macOS only — so this script is what makes one, and what signs with a real
# Developer ID. `drift-package doctor` prints which of the two a machine is on.
#
# The signing mode is decided by `planSigning` from the environment and printed by the build. With
# no certificate this is an **ad-hoc** signature, which is the minimum that runs: Apple Silicon's
# loader refuses an unsigned binary outright. A .dmg built that way still carries the quarantine
# flag when downloaded, and the first launch is refused until `xattr -dr com.apple.quarantine`
# clears it — which is the reason to buy a Developer ID eventually, and not a reason to wait.
#
#   ./build-macos.sh --project ~/work/game
#   CSC_LINK=~/certs/developer-id.p12 CSC_KEY_PASSWORD=... ./build-macos.sh --project .
#   APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... ./build-macos.sh --project .

set -euo pipefail

PROJECT=""
TARGET="mac-arm64"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --target)  TARGET="$2";  shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$PROJECT" ] || { echo "--project is required" >&2; exit 2; }
[ -f "$PROJECT/drift.package.json" ] || {
  echo "no drift.package.json in $PROJECT; that file is what a build is configured from" >&2
  exit 1
}

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
command -v codesign >/dev/null || {
  echo "codesign is missing: install the Xcode command line tools with xcode-select --install" >&2
  exit 1
}

# See the note in build-windows.ps1: an Electron-based terminal exports this, and it turns the
# artifact into one that cannot find Electron.
unset ELECTRON_RUN_AS_NODE

cd "$PROJECT"
npm ci
npx drift-package doctor
npx drift-package build --target="$TARGET"

echo
echo "Artifacts:"
find "out/$TARGET" -maxdepth 1 -type f -print

# Said again at the end, because the interesting line scrolled past twenty minutes ago.
if [ -z "${CSC_LINK:-}${CSC_NAME:-}" ]; then
  cat <<'EOF'

This build is ad-hoc signed. It runs here. A copy downloaded through a browser will be refused by
Gatekeeper until the person clears the quarantine flag:

    xattr -dr com.apple.quarantine "/Applications/<the app>.app"

A Developer ID certificate in CSC_LINK removes that, and notarisation credentials remove it for
everybody rather than for the people willing to run a command.
EOF
fi
