#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")/.." && pwd)"
REPO_NAME="PiMemoryExtension"

echo "=== JS memory-code Benchmark ==="
echo "Date: $(date -I)"
echo "Repo: $REPO_NAME"
echo

# Reindex
echo "--- reindex-repo ---"
time node "$REPO_PATH/memory-store.js" reindex-repo --repo "$REPO_NAME" 2>&1 | tail -5

echo
echo "--- outline ---"
time node "$REPO_PATH/memory-store.js" outline --repo "$REPO_NAME" --file db.js 2>&1 | tail -3

echo
echo "--- call-hierarchy ---"
time node "$REPO_PATH/memory-store.js" call-hierarchy --symbol createDb --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- import-graph ---"
time node "$REPO_PATH/memory-store.js" import-graph --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- cycles ---"
time node "$REPO_PATH/memory-store.js" cycles --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- importance ---"
time node "$REPO_PATH/memory-store.js" importance --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- dead-code ---"
time node "$REPO_PATH/memory-store.js" dead-code --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- blast-radius ---"
time node "$REPO_PATH/memory-store.js" blast-radius --symbol createDb --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- hotspots ---"
time node "$REPO_PATH/memory-store.js" hotspots --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "--- coupling ---"
time node "$REPO_PATH/memory-store.js" coupling --repo "$REPO_NAME" 2>&1 | tail -3

echo
echo "=== Benchmark Complete ==="
