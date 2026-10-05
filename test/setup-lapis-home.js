// Setup file: test/setup-lapis-home.js — per-file LAPIS_HOME isolation for vitest.
//
// WHY: CLI-spawning integration tests (memory-store.test.js et al.) save real
// Observations through the real gateway. Without redirection those writes land
// In the PRODUCTION DB (~/.pi/memory/memory.db) — the root cause of ~10k junk
// Rows (test-mem-*, test-nan-*, edge-test-*) cleaned up on 2026-10-05.
//
// HOW: config.js resolves HOME as `LAPIS_HOME || HOME || ...` at module load;
// The db_path, CONFIG_PATH and WAL files all derive from it. Pointing LAPIS_HOME
// At a fresh per-file temp dir gives every test file its own throwaway DB —
// Auto-initialized by ensureDb() (mkdirSync recursive + migrations) — and
// Judgment config falls back to heuristic defaults (no accidental API keys or
// Network calls in tests).
//
// Registered in vitest.config.mjs as a setupFile. Runs BEFORE each test
// File's imports, so every in-process module (config.js, db.js) and every
// Spawned child process (execFileSync(memory-store.js, ...)) sees the same temp home.
const os = require('os'),
  path = require('path'),
  fs = require('fs'),
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-test-home-'));
process.env.LAPIS_HOME = tmpHome;

afterAll(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort — OS temp cleanup is the backstop
  }
});
