// Regression tests for code-audit MEDIUM findings (#7, #8, #9).
// Each sub-describe covers one verified bug fix.
// Run via: npm test -- code-audit-medium-fixes

const { resolveScopeBindingsForFiles } = require('../src/code-index/scope-resolver');
const { winnow } = require('../src/code-analysis/import-graph-impl');
const { extractHtmlSections } = require('../src/doc-index/html-parser');

// ── #7: resolveScopeBindingsForFiles must return { resolved, ... } (not undefined) ──

describe('code-audit #7: incremental scope resolution return value', () => {
  // A native-style mock db: accepts all writes, returns the given binding for the
  // direct-resolution SELECT and empty results everywhere else. This isolates the
  // return-value contract from the SQLite backend.
  function makeScopeResolverDb(binding) {
    const writes = [];
    const db = {
      transaction: (fn) => () => fn(),
      exec() {},
      prepare(sql) {
        const n = sql.replace(/\s+/g, ' ').trim();
        return {
          run(...params) {
            writes.push({ sql: n, params });
            return { changes: 0, lastInsertRowid: 0 };
          },
          get() {
            return undefined;
          },
          all() {
            // Direct-resolution bindings for affected files
            if (n.includes('FROM file_scope_bindings fsb') && n.includes('fsb.file_id = ?')) {
              return binding ? [binding] : [];
            }
            return [];
          },
        };
      },
    };
    return { db, writes };
  }

  it('returns an object with numeric resolved count (caller can read sr.resolved)', () => {
    const binding = {
      id: 42,
      file_id: 10,
      name: 'lodash',
      kind: 'named_import',
      origin: 'external_package',
      source_file_id: null,
      source_name: 'lodash',
      line_start: 1,
      line_end: 1,
    };
    const { db, writes } = makeScopeResolverDb(binding);

    let result;
    // Before the fix the function returned undefined, so `result.resolved` threw
    // a TypeError that the caller swallowed (logging a misleading error and
    // always reporting scopeResolved = 0).
    expect(() => {
      result = resolveScopeBindingsForFiles(db, 1, [10], []);
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    expect(typeof result.resolved).toBe('number');
    // external_package bindings resolve immediately → counted as resolved.
    expect(result.resolved).toBe(1);
    expect(typeof result.unresolved).toBe('number');
    expect(Array.isArray(result.warnings)).toBe(true);
    // A scope_resolution row was actually inserted for the binding.
    expect(writes.some((w) => w.sql.startsWith('INSERT INTO scope_resolution'))).toBe(true);
  });
});

// ── #8: winnow must SELECT the column each sort axis sorts on ──

describe('code-audit #8: winnow sort axis selects its sort column', () => {
  // A mock native-style db that:
  //  - answers the two PageRank queries (calls + symbols)
  //  - captures the main winnow SELECT and projects returned rows to ONLY the
  //    columns present in the SELECT. This faithfully reproduces the bug: when a
  //    sort column is missing from SELECT, the projected rows lack it and the
  //    comparator sees `undefined` (a no-op sort).
  function makeWinnowDb(repoId, symbols, fullRows) {
    const captured = { sql: null, params: null };
    const db = {
      prepare(sql) {
        const n = sql.replace(/\s+/g, ' ').trim();
        return {
          all(...params) {
            // PageRank call edges query → none for this test
            if (n.includes('FROM code_calls cc JOIN code_symbols cs')) {
              return [];
            }
            // PageRank symbols query
            if (n.startsWith('SELECT id, name, kind, file_path FROM code_symbols WHERE repo_id = ?')) {
              return symbols;
            }
            // Main winnow query
            captured.sql = n;
            captured.params = params;
            const selectMatch = n.match(/SELECT\s+(.*?)\s+FROM\s+code_symbols\s+s/i);
            const colNames = selectMatch
              ? selectMatch[1]
                  .split(',')
                  .map((c) => c.trim())
                  .map((c) => c.split('.').pop())
              : [];
            // Project to only the selected columns, preserving query order.
            return fullRows.map((fr) => {
              const row = {};
              for (const cn of colNames) {
                row[cn] = fr[cn];
              }
              return row;
            });
          },
        };
      },
    };
    return { db, getCaptured: () => captured };
  }

  const symbols = [
    { id: 1, name: 'low', kind: 'function', file_path: '/r/a.js' },
    { id: 2, name: 'high', kind: 'function', file_path: '/r/a.js' },
  ];

  it('sorts by complexity (SELECTs + uses sc.cyclomatic)', () => {
    // Insert order intentionally "wrong" so a no-op sort would leave `low` first.
    const fullRows = [
      {
        id: 1,
        name: 'low',
        kind: 'function',
        file_path: '/r/a.js',
        signature: null,
        start_line: 1,
        end_line: 2,
        cyclomatic: 1,
      },
      {
        id: 2,
        name: 'high',
        kind: 'function',
        file_path: '/r/a.js',
        signature: null,
        start_line: 3,
        end_line: 4,
        cyclomatic: 9,
      },
    ];
    const { db, getCaptured } = makeWinnowDb(9001, symbols, fullRows);
    const res = winnow(db, 9001, { sortBy: 'complexity', top: 10 });
    expect(res.results.length).toBe(2);
    // Higher complexity must come first — fails if cyclomatic was not selected.
    expect(res.results[0].cyclomatic).toBe(9);
    expect(getCaptured().sql).toContain('sc.cyclomatic');
  });

  it('sorts by churn (SELECTs + uses cm.commits)', () => {
    const fullRows = [
      {
        id: 1,
        name: 'low',
        kind: 'function',
        file_path: '/r/a.js',
        signature: null,
        start_line: 1,
        end_line: 2,
        commits: 2,
      },
      {
        id: 2,
        name: 'high',
        kind: 'function',
        file_path: '/r/a.js',
        signature: null,
        start_line: 3,
        end_line: 4,
        commits: 7,
      },
    ];
    const { db, getCaptured } = makeWinnowDb(9002, symbols, fullRows);
    const res = winnow(db, 9002, { sortBy: 'churn', top: 10 });
    expect(res.results[0].commits).toBe(7);
    expect(getCaptured().sql).toContain('cm.commits');
  });

  it('sorts by callers (SELECTs + uses cc_cnt.caller_count)', () => {
    const fullRows = [
      {
        id: 1,
        name: 'low',
        kind: 'function',
        file_path: '/r/a.js',
        signature: null,
        start_line: 1,
        end_line: 2,
        caller_count: 0,
      },
      {
        id: 2,
        name: 'high',
        kind: 'function',
        file_path: '/r/a.js',
        signature: null,
        start_line: 3,
        end_line: 4,
        caller_count: 5,
      },
    ];
    const { db, getCaptured } = makeWinnowDb(9003, symbols, fullRows);
    const res = winnow(db, 9003, { sortBy: 'callers', top: 10 });
    expect(res.results[0].caller_count).toBe(5);
    expect(getCaptured().sql).toContain('cc_cnt.caller_count');
  });
});

// ── #9: extractHtmlSections must feed raw HTML to extractHtmlTags ──

describe('code-audit #9: html section tags extracted from raw HTML', () => {
  it('populates tags for the preamble and heading-loop branches', () => {
    const html = [
      '<html><body>',
      '<p class="intro">Welcome</p>',
      '<h1>Docs</h1>',
      '<div class="api-reference">body</div>',
      '</body></html>',
    ].join('\n');

    const sections = extractHtmlSections(html, 'page.html');
    // A doc with <h1> takes the preamble + heading-loop path (the previously
    // broken branches). Tags used to be '' for every such section.
    const allTags = sections.map((s) => s.tags).join(',');
    expect(allTags).toContain('intro');
    expect(allTags).toContain('api-reference');
  });

  it('still extracts tags for the no-headings branch (unchanged)', () => {
    const html = '<html><body><div class="landing">no headings here</div></body></html>';
    const sections = extractHtmlSections(html, 'flat.html');
    expect(sections[0].tags).toContain('landing');
  });
});
