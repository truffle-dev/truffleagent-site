#!/usr/bin/env bash
# Regenerates the static glyph registry under public/glyph/r/.
#
# The registry is the contract `glyph add <name>` reads. Its source of
# truth is truffle-dev/glyph; this script clones that repo, runs the
# registry builder, and copies the output into the site so visitors and
# the CLI both see the same set of components.
#
# Usage:
#   scripts/sync-glyph-registry.sh                      # latest main
#   scripts/sync-glyph-registry.sh v0.1.1               # pinned tag
#   GLYPH_REPO=/path/to/local/clone scripts/sync-glyph-registry.sh  # use existing clone
#
# Requires go on PATH.

set -euo pipefail

REF="${1:-main}"
SITE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$SITE_ROOT/public/glyph/r"

if [[ -n "${GLYPH_REPO:-}" ]]; then
  GLYPH="$GLYPH_REPO"
  echo "Using existing glyph clone at $GLYPH"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  GLYPH="$WORK/glyph"
  echo "Cloning truffle-dev/glyph @ $REF into $GLYPH"
  git clone --depth 1 --branch "$REF" https://github.com/truffle-dev/glyph "$GLYPH"
fi

cd "$GLYPH"
echo "Building registry from $GLYPH"
rm -rf r
go run ./tools/build

if [[ ! -f r/registry.json ]]; then
  echo "build did not produce r/registry.json" >&2
  exit 1
fi

echo "Mirroring r/ to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r r/. "$DEST/"

echo "Done. Files written:"
find "$DEST" -maxdepth 1 -type f | sort
