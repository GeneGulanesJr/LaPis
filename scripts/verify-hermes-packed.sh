#!/usr/bin/env bash
# scripts/verify-hermes-packed.sh
#
# Local reproduction of .github/workflows/hermes-pack-verify.yml.
#
# End-to-end validation that the PUBLISHED LaPis artifact integrates cleanly
# into a Hermes Agent install. Complements scripts/verify-packed-package.sh,
# which only checks the tarball + bin + native module — it never exercises
# the actual `lapis hermes <install|doctor|hook|uninstall>` lifecycle.
#
# What this script does:
#   1. `npm pack` the repo into a temp dir and extract the tarball
#   2. install the extracted package's PRODUCTION dependencies in a clean
#      context (builds the better-sqlite3 native module end to end)
#   3. verify every critical packed resource for the Hermes integration
#   4. seed a sentinel user MCP server + user hook into a fresh config.yaml
#      so the uninstall step can prove LaPis removes only its own entries
#   5. run `lapis hermes install --home <HERMES_HOME>` from the packed
#      artifact and assert config, MCP entry, LAPIS_HOME env, all five
#      hook events, allowlist approvals, and bundled skill installation
#   6. run `lapis hermes doctor` and assert exit 0 (every check passes)
#   7. feed representative JSON payloads to `lapis hermes hook` via stdin
#      and assert the expected wire format / exit codes
#   8. run `lapis hermes uninstall` and assert LaPis entries are gone while
#      the sentinel user MCP server + user hook are preserved
#   9. assert package.json version + lock consistency for the tarball
#
# Usage:
#   bash scripts/verify-hermes-packed.sh
#   bash scripts/verify-hermes-packed.sh --skip-deps   # skip npm install
#                                                # (use an already-built node_modules)
#
# Exit codes: 0 = all checks passed, non-zero = a check failed.
#
# NOTE: better-sqlite3 is a shipped runtime native dependency. This script
# intentionally installs it (not --omit'd) so the native build/load path
# that real consumers hit is exercised end to end. A native build toolchain
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

# ─────────────────────────────────────────────────────────────────────────────
# (1) pack + extract
# ─────────────────────────────────────────────────────────────────────────────
TGZ_NAME="$(npm pack --pack-destination="$WORK" | tail -n1)"
TGZ="$WORK/$TGZ_NAME"
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

BIN="$EXTRACT/memory-store.js"

# ─────────────────────────────────────────────────────────────────────────────
# (3) verify critical packed resources for the Hermes integration
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Verifying critical Hermes packed resources"
for f in \
    memory-store.js \
    src/hermes/install.js \
    src/hermes/doctor.js \
    src/hermes/uninstall.js \
    src/hermes/hook.js \
    src/hermes/config-editor.js \
    src/hermes/state-store.js \
    src/hooks-engine/guardrail-utils.js \
    src/hooks-engine/project.js \
    src/hooks-engine/context-builder.js \
    src/code-index/scanner.js \
    hermes/SKILL.md; do
  test -f "$EXTRACT/$f" || { echo "MISSING: $f" >&2; exit 1; }
  echo "   ok $f"
done

# ─────────────────────────────────────────────────────────────────────────────
# (4) seed a sentinel user MCP server + user hook into a fresh Hermes home
# ─────────────────────────────────────────────────────────────────────────────
HERMES_HOME="$WORK/hermes-home"
LAPIS_HOME="$WORK/lapis-home"
mkdir -p "$HERMES_HOME" "$LAPIS_HOME"

cat > "$HERMES_HOME/config.yaml" <<'YAML'
mcp_servers:
  user-mcp:
    command: /usr/local/bin/node
    args:
      - /tmp/user-mcp/server.js
    enabled: true

hooks:
  pre_tool_call:
    - matcher: "^write_file$"
      command: "/usr/local/bin/node /tmp/user-hook.js"
      timeout: 5
  on_session_start:
    - command: "/usr/local/bin/node /tmp/user-start-hook.js"
      timeout: 5
YAML

# Isolated HOME so neither install nor the hook handler picks up the
# developer's ~/.hermes or ~/.pi by accident — this is hermetic CI mode.
export HOME="$WORK/ci-home"
mkdir -p "$HOME"
export LAPIS_HOME="$LAPIS_HOME"

# ─────────────────────────────────────────────────────────────────────────────
# (5) `lapis hermes install` from the packed artifact
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Running lapis hermes install (packed artifact)"
( cd "$EXTRACT" && node "$BIN" hermes install --home "$HERMES_HOME" )

# ─────────────────────────────────────────────────────────────────────────────
# (6) assert install layout
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Asserting install layout"
CONFIG="$HERMES_HOME/config.yaml"
ALLOW="$HERMES_HOME/shell-hooks-allowlist.json"
SKILL="$HERMES_HOME/skills/memory/lapis/SKILL.md"

test -s "$CONFIG" || { echo "MISSING/EMPTY: $CONFIG" >&2; exit 1; }
grep -q '^  lapis:' "$CONFIG"              || { echo "mcp_servers.lapis missing" >&2; exit 1; }
grep -q 'memory-store.js' "$CONFIG"        || { echo "mcp_servers.lapis missing memory-store.js path" >&2; exit 1; }
grep -q 'LAPIS_HOME:' "$CONFIG"            || { echo "mcp_servers.lapis missing LAPIS_HOME env" >&2; exit 1; }
for ev in pre_tool_call post_tool_call pre_llm_call on_session_start on_session_end; do
  grep -qE "^  ${ev}:" "$CONFIG"           || { echo "hook event missing: $ev" >&2; exit 1; }
done
grep -q 'hooks_auto_accept: true' "$CONFIG" || { echo "hooks_auto_accept not true" >&2; exit 1; }
grep -q '^  user-mcp:' "$CONFIG"           || { echo "sentinel user-mcp was clobbered" >&2; exit 1; }
grep -q '/tmp/user-hook.js' "$CONFIG"      || { echo "sentinel user hook was clobbered" >&2; exit 1; }
echo "   ok config.yaml: mcp_servers.lapis + LAPIS_HOME + 5 hook events + hooks_auto_accept + sentinels intact"

test -s "$ALLOW" || { echo "MISSING/EMPTY: $ALLOW" >&2; exit 1; }
node -e "
  const fs = require('fs');
  const allow = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const events = (allow.approvals || []).map(a => a && a.event).filter(Boolean);
  const want = ['pre_tool_call','post_tool_call','pre_llm_call','on_session_start','on_session_end'];
  const missing = want.filter(e => !events.includes(e));
  if (missing.length) { console.error('allowlist missing events: ' + missing.join(',')); process.exit(1); }
" "$ALLOW"
echo "   ok shell-hooks-allowlist.json: 5 approvals present"

test -s "$SKILL" || { echo "MISSING skill: $SKILL" >&2; exit 1; }
# Skill files use YAML frontmatter (--- name/description … ---) followed by
# Markdown body. Either is a valid shape — assert the frontmatter is present.
head -n 1 "$SKILL" | grep -qE '^(---\s*|#\s|name:)' || { echo "skill file does not look like a valid SKILL.md (no frontmatter or Markdown heading)" >&2; exit 1; }
grep -q '^name: lapis' "$SKILL" || { echo "skill file missing 'name: lapis' frontmatter" >&2; exit 1; }
echo "   ok skill installed at $SKILL"

# ─────────────────────────────────────────────────────────────────────────────
# (7) `lapis hermes doctor` must exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Running lapis hermes doctor"
set +e
DOC_OUT="$(cd "$EXTRACT" && node "$BIN" hermes doctor --home "$HERMES_HOME" 2>&1)"
DOC_RC=$?
set -e
echo "$DOC_OUT"
if [ "$DOC_RC" -ne 0 ]; then
  echo "doctor exited non-zero ($DOC_RC)" >&2
  exit 1
fi
if echo "$DOC_OUT" | grep -q '^✗'; then
  echo "doctor reported one or more failing checks" >&2
  exit 1
fi
if ! echo "$DOC_OUT" | grep -q 'All checks passed.'; then
  echo "doctor did not report 'All checks passed.'" >&2
  exit 1
fi
echo "   ok lapis hermes doctor: all checks passed, exit 0"

# ─────────────────────────────────────────────────────────────────────────────
# (8) exercise `lapis hermes hook` with representative payloads
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Exercising lapis hermes hook"

# (a) on_session_start: silent, exit 0.
set +e
OUT=$(echo '{"hook_event_name":"on_session_start","session_id":"ci-session","cwd":"'"$HERMES_HOME"'","extra":{"user_message":"hello"}}' \
    | ( cd "$EXTRACT" && node "$BIN" hermes hook 2>&1 ))
RC=$?
set -e
if [ "$RC" -ne 0 ]; then echo "on_session_start exited non-zero ($RC): $OUT" >&2; exit 1; fi
if [ -n "$OUT" ]; then echo "on_session_start should be silent, got: $OUT" >&2; exit 1; fi
echo "   ok on_session_start: silent, exit 0"

# (b) pre_tool_call (read_file on a non-code path): silent.
set +e
OUT=$(echo '{"hook_event_name":"pre_tool_call","tool_name":"read_file","tool_input":{"file_path":"/tmp/not-code.txt"},"session_id":"ci-session","cwd":"'"$HERMES_HOME"'"}' \
    | ( cd "$EXTRACT" && node "$BIN" hermes hook 2>&1 ))
RC=$?
set -e
if [ "$RC" -ne 0 ] || [ -n "$OUT" ]; then
  echo "pre_tool_call(non-code) should be silent+0, got rc=$RC out=$OUT" >&2
  exit 1
fi
echo "   ok pre_tool_call(read_file, non-code): silent, exit 0"

# (c) pre_tool_call (search_files): handled cleanly.
set +e
OUT=$(echo '{"hook_event_name":"pre_tool_call","tool_name":"search_files","tool_input":{"pattern":"foo|bar|baz","path":"'"$HERMES_HOME"'"},"session_id":"ci-session","cwd":"'"$HERMES_HOME"'"}' \
    | ( cd "$EXTRACT" && node "$BIN" hermes hook 2>&1 ))
RC=$?
set -e
if [ "$RC" -ne 0 ]; then echo "pre_tool_call(search_files) exited non-zero ($RC): $OUT" >&2; exit 1; fi
echo "   ok pre_tool_call(search_files): handled cleanly, exit 0"

# (d) pre_llm_call: emits a {context: "..."} envelope, or silent.
set +e
OUT=$(echo '{"hook_event_name":"pre_llm_call","session_id":"ci-session","cwd":"'"$HERMES_HOME"'","extra":{"user_message":"what did we decide about LaPis"}}' \
    | ( cd "$EXTRACT" && node "$BIN" hermes hook 2>&1 ))
RC=$?
set -e
if [ "$RC" -ne 0 ]; then echo "pre_llm_call exited non-zero ($RC): $OUT" >&2; exit 1; fi
if [ -n "$OUT" ]; then
  node -e "
    const out = process.argv[1];
    let parsed;
    try { parsed = JSON.parse(out); } catch (e) { console.error('pre_llm_call stdout is not valid JSON: ' + out); process.exit(1); }
    if (typeof parsed !== 'object' || parsed === null) { console.error('pre_llm_call stdout is not a JSON object'); process.exit(1); }
    if (!('context' in parsed) && !('decision' in parsed)) { console.error('pre_llm_call stdout missing context/decision keys'); process.exit(1); }
    console.log('   ok pre_llm_call: wire format OK (' + (parsed.context ? 'context block' : 'decision: ' + parsed.decision) + ')');
  " "$OUT"
else
  echo "   ok pre_llm_call: silent (no context matched) — exit 0"
fi

# (e) on_session_end: silent, exit 0.
set +e
OUT=$(echo '{"hook_event_name":"on_session_end","session_id":"ci-session","cwd":"'"$HERMES_HOME"'"}' \
    | ( cd "$EXTRACT" && node "$BIN" hermes hook 2>&1 ))
RC=$?
set -e
if [ "$RC" -ne 0 ] || [ -n "$OUT" ]; then echo "on_session_end should be silent+0, got rc=$RC out=$OUT" >&2; exit 1; fi
echo "   ok on_session_end: silent, exit 0"

# (f) garbage input: fail-open.
set +e
OUT=$(echo 'this is not json' | ( cd "$EXTRACT" && node "$BIN" hermes hook 2>&1 ))
RC=$?
set -e
if [ "$RC" -ne 0 ] || [ -n "$OUT" ]; then echo "garbage input should fail-open, got rc=$RC out=$OUT" >&2; exit 1; fi
echo "   ok garbage input: fail-open, exit 0"

# ─────────────────────────────────────────────────────────────────────────────
# (9) `lapis hermes uninstall` must remove LaPis entries while preserving
#     the sentinel user MCP server + user hook
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Running lapis hermes uninstall"
( cd "$EXTRACT" && node "$BIN" hermes uninstall --home "$HERMES_HOME" )

if grep -q '^  lapis:' "$CONFIG"; then
  echo "uninstall left mcp_servers.lapis behind" >&2; exit 1
fi
grep -q '^  user-mcp:' "$CONFIG" \
    || { echo "uninstall removed sentinel user-mcp" >&2; exit 1; }
grep -q '/tmp/user-hook.js' "$CONFIG" \
    || { echo "uninstall removed sentinel user hook" >&2; exit 1; }
if grep -q 'memory-store.js hermes hook' "$CONFIG"; then
  echo "uninstall left LaPis hook items behind" >&2; exit 1
fi
# hooks_auto_accept must be PRESERVED here because the sentinel user hooks
# remain (they rely on it for headless consent). The empty-hooks case where
# uninstall removes it is covered by test/hermes/install.test.js.
if ! grep -q 'hooks_auto_accept' "$CONFIG"; then
  echo "uninstall removed hooks_auto_accept while sentinel user hooks still rely on it" >&2; exit 1
fi
echo "   ok uninstall: LaPis entries removed, sentinel user entries + hooks_auto_accept preserved"

# ─────────────────────────────────────────────────────────────────────────────
# (10) version/lock consistency
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Version/lock consistency"
EXPECTED="$(node -p "require('$EXTRACT/package.json').version")"
BASENAME="$(basename "$TGZ")"
case "$BASENAME" in
  *-"$EXPECTED".tgz) echo "   ok tarball version matches package.json ($EXPECTED)" ;;
  *) echo "   FAIL tarball $BASENAME !~ -$EXPECTED.tgz" >&2; exit 1 ;;
esac

echo
echo "ALL hermes-pack-verify checks passed."