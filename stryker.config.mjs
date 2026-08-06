// @ts-check
/**
 * Stryker mutation testing config for LaPis.
 *
 * Baseline scope: P0 (high-risk) — memory-domain core (search/rank/dedupe/recall)
 * + platform memory repository. These are the files that determine what the
 * Pi agent actually recalls and how it ranks memories.
 *
 * Expand scope as mutation score improves. See docs/MUTATION_TESTING.md.
 *
 * Usage:
 *   npm run test:mutation          # run all configured mutants
 *   npm run test:mutation:diff     # only mutate changed files (pre-refactor)
 *
 * Reference: https://stryker-mutator.io/docs/stryker-js/configuration
 */
export default {
  packageManager: 'npm',
  // Explicit plugin list — Stryker 9 needs this when packages are installed
  // via npm (auto-discovery via keywords doesn't always trigger).
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  reporters: ['html', 'clear-text', 'progress', 'json'],
  testRunner: 'vitest',
  // perTest = only run tests that cover the mutated line (huge speedup).
  // Falls back to "all" automatically if the runner can't compute coverage
  // (LaPis doesn't ship @vitest/coverage-v8 by default — install it for
  // perTest speed, otherwise all tests run per mutant).
  coverageAnalysis: 'perTest',
  // Incremental runs share results with previous runs (skip already-killed mutants).
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 80, low: 70, break: 60 },
  timeoutMS: 60_000,
  // P0: the brain of LaPis — what gets recalled and how it ranks.
  // Mutations here directly change what the Pi agent sees in context.
  // P1/P2 (compaction, observation storage, code-index) added after baseline.
  mutate: [
    'src/memory-domain/search.js', // search + ranking (414 lines)
    'src/memory-domain/dedupe.js', // memory deduplication (85 lines)
    'src/memory-domain/recall.js', // recall orchestration (22 lines)
    'src/memory-domain/context.js', // context building (320 lines)
    'src/platform/storage/repositories/memory.js', // core memory CRUD (70 lines)
  ],
  // Don't try to mutate generated files, type-declarations, or vendored deps.
  // DO NOT exclude test/ — vitest needs it in the sandbox.
  ignorePatterns: [
    '**/*.d.ts',
    '**/*.min.js',
    '**/node_modules/**',
    '.worktrees/**',
    'reports/**',
    'dist/**',
    '**/coverage/**',
    'bench/**',
    // grammars/** NOT excluded — tree-sitter WASM files are needed by
    // index-repo tests. They're git-tracked so they copy into the sandbox.
  ],
  vitest: {
    configFile: 'vitest.config.mjs',
    // Disable vitest's "related test" detection — it requires every source
    // file to be importable from test files, which breaks for cross-module
    // imports in LaPis. We'll pay the cost of running all tests per mutant
    // in exchange for actually running tests.
    related: false,
  },
  tsconfigFile: 'tsconfig.json',
  // Surface surviving mutants prominently in clear-text output.
  clearTextReporter: {
    reportMutantsWithoutCoverage: true,
    skipFull: false,
  },
  // JSON report for CI diffing + HTML for human review.
  jsonReporter: { fileName: 'reports/stryker-report.json' },
  htmlReporter: { fileName: 'reports/stryker-report.html' },
};
