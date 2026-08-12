#!/usr/bin/env bash
# scripts/verify-packed-package.sh
#
# Local reproduction of .github/workflows/pack-verify.yml.
# Validates the PUBLISHED artifact (npm pack result), not the working tree:
# packs the repo, extracts the tarball, installs PRODUCTION deps in a clean
# context (which builds the better-sqlite3 native module), verifies critical
# resources, exercises the bin, and runs `npm audit --omit=dev`.
#
# Usage:
#   bash scripts/verify-packed-package.sh
#   bash scripts/verify-packed-package.sh --skip-deps   # skip the npm install
#                                                       # (use an already-built node_modules)
#
# Exit codes: 0 = all checks passed, non-zero = a check failed.
#
# NOTE: better-sqlite3 is a shipped runtime native dependency. This script
# intentionally installs it (not --omit'd) so the native build/load path that
# real consumers hit is exercised end to end. A native build toolchain
# (python3, make, C++ compiler) must be available.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --skip-deps) SKIP_DEPS=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d)"
export WORK
trap 'rm -rf "$WORK"' EXIT

echo "==> Workspace: $WORK"

# (1) pack + extract.
# `npm pack --pack-destination=DIR` writes the tarball into DIR but prints
# only the bare FILENAME on stdout, so we join it back onto WORK ourselves.
TGZ_NAME="$(npm pack --pack-destination="$WORK" | tail -n1)"
TGZ="$WORK/$TGZ_NAME"
# npm tarballs embed a top-level `package/` dir; extract into WORK so files
# land at $WORK/package/…
tar -xzf "$TGZ" -C "$WORK"
EXTRACT="$WORK/package"
echo "==> Extracted tarball -> $EXTRACT"

# (2) install PRODUCTION deps in extracted package (builds better-sqlite3)
if [ "$SKIP_DEPS" -eq 1 ]; then
  echo "==> --skip-deps: skipping npm install"
else
  echo "==> Installing production deps in extracted package (builds better-sqlite3)…"
  ( cd "$EXTRACT" && npm install --omit=dev --loglevel=error )
fi

# (3) verify critical packed resources
echo "==> Verifying critical packed resources"
for f in \
    memory-store.js \
    postinstall.js \
    scripts/postinstall-helpers.js \
    hermes/SKILL.md \
    grammars/tree-sitter-html.wasm; do
  test -f "$EXTRACT/$f" || { echo "MISSING: $f" >&2; exit 1; }
  echo "   ok $f"
done
for d in extensions skills prompts grammars; do
  if [ ! -d "$EXTRACT/$d" ] || [ -z "$(ls -A "$EXTRACT/$d")" ]; then
    echo "MISSING/EMPTY dir: $d" >&2; exit 1
  fi
  echo "   ok $d/ ($(find "$EXTRACT/$d" -type f | wc -l) files)"
done

# (4) native load check + bin smoke
echo "==> Native better-sqlite3 load check"
( cd "$EXTRACT" && node -e \
  "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(x)'); db.prepare('insert into t values (?)').run(42); const r=db.prepare('select x from t').get(); if(r.x!==42)throw 0; console.log('   ok native load + roundtrip')" )

echo "==> Packed bin smoke (--help, stats, save, search)"
export LAPIS_HOME="$WORK/lapis-home"
export HOME="$WORK/ci-home"
mkdir -p "$LAPIS_HOME" "$HOME"
BIN="node $EXTRACT/memory-store.js"
$BIN --help | head -n 3
$BIN stats
$BIN save --title "local pack-verify" --content "What: smoke. Why: local. Where: scripts/verify-packed-package.sh" --type manual || true
# Pass a real --query so search exercises the SQLite read path
# (search with no query returns {"error":"Missing --query"}).
$BIN search --query "smoke" || true

# (5) version/lock consistency
echo "==> Version/lock consistency"
EXPECTED="$(node -p "require('$EXTRACT/package.json').version")"
BASENAME="$(basename "$TGZ")"
case "$BASENAME" in
  *-"$EXPECTED".tgz) echo "   ok tarball version matches package.json ($EXPECTED)" ;;
  *) echo "   FAIL tarball $BASENAME !~ -$EXPECTED.tgz" >&2; exit 1 ;;
esac

# (6) npm audit (production, high+)
echo "==> npm audit --omit=dev --audit-level=high"
( cd "$EXTRACT" && npm audit --omit=dev --audit-level=high )

echo
echo "ALL pack-verify checks passed."
