// Regression tests for correctness review findings F23-F26.
//
// F23: src/memory-domain/search.js + context.js — LIKE patterns escaped `%`
//      and `_` with a backslash but omitted the ESCAPE clause, so SQLite
//      treated the backslash as a literal char and any query containing `_`
//      or `%` silently matched nothing.
// F24: src/code-analysis/import-graph-impl.js — winnow destructured
//      `minPageRank` into `_minPageRank` and never applied it, so the
//      `--min-pagerank` CLI flag silently did nothing.
// F25: src/code-index/path-guards.js + incremental-indexer.js — deleted files
//      were routed through resolveRepoScopedPath, which realpathSyncs the
//      candidate; a deleted file throws ENOENT and is rejected before it can
//      be recorded as deleted, so incremental reindex left orphaned rows.

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('correctness review fixes (round 3) — F23-F26', () => {
  // ── F23: LIKE escape clauses carry ESCAPE '\' ──────────────────────────
  it('F23a: search.js LIKE fallback includes ESCAPE clause with a backslash', () => {
    const src = fs.readFileSync(require.resolve('../src/memory-domain/search'), 'utf8');
    // The fallback WHERE must use LIKE ? ESCAPE so escaped %/_ are literals.
    expect(src).toMatch(/LIKE \? ESCAPE/);
    // The escape char in the generated SQL must be a real backslash, not the
    // empty string produced by a JS-escaped quote ('\' -> ''). In source the
    // backslash is doubled ('\\'), so the captured group contains a backslash.
    const m = src.match(/LIKE \? ESCAPE '([^']*)'/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('\\');
    expect(m[1].length).toBeGreaterThan(0);
  });

  it('F23b: context.js buildTopicQueryMatch emits ESCAPE on WHERE and SCORE', () => {
    const src = fs.readFileSync(require.resolve('../src/memory-domain/context'), 'utf8');
    // Every LIKE clause (where + score) must carry ESCAPE.
    const likeClauses = src.match(/LIKE \?/g) || [];
    const escapedClauses = src.match(/LIKE \? ESCAPE/g) || [];
    expect(escapedClauses.length).toBe(likeClauses.length);
    expect(likeClauses.length).toBeGreaterThan(0);
    // And the escape char must be a real backslash (doubled in source).
    const m = src.match(/LIKE \? ESCAPE '([^']*)'/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('\\');
    expect(m[1].length).toBeGreaterThan(0);
  });

  it('F23c: queries containing _ produce an escaped LIKE param', () => {
    const { buildTopicQueryMatch } = require('../src/memory-domain/context');
    const result = buildTopicQueryMatch(['file_name']);
    // The escaped param must contain a literal backslash before the _.
    expect(result.whereParams[0]).toBe('%file\\_name%');
    // The WHERE SQL must reference ESCAPE so the backslash is honored.
    expect(result.whereSql).toContain('ESCAPE');
  });

  // ── F24: winnow applies minPageRank filter ─────────────────────────────
  it('F24: winnow destructures minPageRank (not _minPageRank) and filters by it', () => {
    const src = fs.readFileSync(
      require.resolve('../src/code-analysis/import-graph-impl'),
      'utf8',
    );
    // The pre-fix bug renamed the opt to _minPageRank (unused marker).
    expect(src).not.toMatch(/minPageRank:\s*_minPageRank/);
    // The fix must both destructure it plainly and apply a filter.
    expect(src).toMatch(/minPageRank\s*=\s*null/);
    expect(src).toMatch(
      /\.filter\(\(row\)\s*=>\s*minPageRank\s*==\s*null\s*\|\|\s*row\.pagerank\s*>=\s*Number\(minPageRank\)\)/,
    );
  });

  // ── F25: deleted files resolve without requiring disk existence ─────────
  it('F25a: path-guards exports an existence-tolerant deleted-path resolver', () => {
    const mod = require('../src/code-index/path-guards');
    expect(typeof mod.resolveRepoScopedDeletedPath).toBe('function');
  });

  it('F25b: resolveRepoScopedDeletedPath returns the path for a non-existent file', () => {
    const { resolveRepoScopedDeletedPath } = require('../src/code-index/path-guards');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-f25-'));
    try {
      const deletedRel = 'gone.js';
      // gone.js does NOT exist on disk — this is the whole point.
      const rejected = [];
      const resolved = resolveRepoScopedDeletedPath(repo, deletedRel, rejected);
      expect(resolved).toBe(path.join(repo, deletedRel));
      expect(rejected).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('F25c: resolveRepoScopedDeletedPath still enforces repo containment', () => {
    const { resolveRepoScopedDeletedPath } = require('../src/code-index/path-guards');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-f25-'));
    try {
      const rejected = [];
      const escaped = resolveRepoScopedDeletedPath(repo, '/etc/passwd', rejected);
      expect(escaped).toBeNull();
      expect(rejected[0]).toMatchObject({ reason: 'outside_repo' });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('F25d: getGitDelta and parseChangedPathsInput route deletes through the deleted resolver', () => {
    const src = fs.readFileSync(
      require.resolve('../src/code-index/incremental-indexer'),
      'utf8',
    );
    // Both delete-classifying sites must use resolveRepoScopedDeletedPath.
    const deleteResolverUses = src.match(/resolveRepoScopedDeletedPath/g) || [];
    expect(deleteResolverUses.length).toBeGreaterThanOrEqual(3); // import + D-branch + rename-from
    expect(src).toMatch(/status\.startsWith\('D'\)[\s\S]*?resolveRepoScopedDeletedPath/);
  });
});
