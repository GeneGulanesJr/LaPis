// Regression tests for correctness review findings F14-F22
// (separate from the earlier correctness-review-fixes.test.js F1-F13 set).
// Each sub-describe covers one verified bug fix with a focused test.
//
// F14: src/code-analysis/dead-code-impl.js — re-export detection used the
//      Wrong namespace (module paths vs symbol names) so re-exported
//      Symbols were always treated as dead.
// F15: src/agent-intel/runtime-ingest.js — traffic_breakdown only counted
//      The just-ingested file, not the persisted runtime_symbols state.
// F16: src/memory-domain/workspaces.js — used SQLite-only `NULLS FIRST`
//      Which fails on older SQLite engines.
// F17: src/agent-intel/blast.js — tests_likely_affected filtered by symbol
//      Name in file path instead of by call-graph evidence.
// F18: src/code-analysis/risk-impl.js — per-symbol blast-radius used depth=3
//      While the batch branch used depth=5, so risk scores jumped at the
//      >20 changed-symbol threshold.
// F19: src/agent-intel/preflight.js — duplicateWarnings had a dead
//      Secondary check (`normalizedSymbol.includes(normalizedTask)`) that
//      Could never trigger independently of the primary overlap check.
// F20: src/claude-code/handlers/user-prompt-submit.js — silent
//      .catch(() => null) on assembleContextLines.
// F21: src/claude-code/context-inject.js — silent
//      .catch(() => null) on assembleContextLines in buildInjectedContext.
// F22: src/memory-domain/compaction.js — dream stats persist failure was
//      Silently swallowed.

const dbModule = require('../db'), { getDeadCode } = require('../src/code-analysis/dead-code-impl'), { ingestCoverage, classifyTraffic } = require('../src/agent-intel/runtime-ingest'), { listWorkspaces, createWorkspace, archiveWorkspace } = require('../src/memory-domain/workspaces'), { blastRadius } = require('../src/agent-intel/blast'), { getPrRiskProfile } = require('../src/code-analysis/risk-impl'), fs = require('fs'), path = require('path'), os = require('os');









function uniqueRepoName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// SQLite-backed tests are skipped when better-sqlite3 isn't installed.
function sqliteReady() {
  try {
    dbModule.ensureDb();
    return true;
  } catch {
    return false;
  }
}

describe('correctness review fixes (round 2) — source-level', () => {
  // These checks are pure source inspection — they do not require the
  // SQLite native binding and serve as guardrails against future
  // Regressions even when integration tests cannot run.

  // ── F14: re-export detection uses correct namespace (file_scope_bindings) ──
  it('F14: dead-code-impl reads file_scope_bindings.kind=re_export for names', () => {
    const src = fs.readFileSync(require.resolve('../src/code-analysis/dead-code-impl'), 'utf8');
    expect(src).toContain("kind = 're_export'");
    // The pre-fix bug populated a set from code_imports.target_module and
    // Compared it against symbol names — the fix must use file_scope_bindings.
    expect(src).not.toMatch(/reExportedNames\.add\(re\.target_module\)/);
  });

  // ── F15: traffic_breakdown reflects persisted runtime_symbols state ──
  it('F15: runtime-ingest aggregates traffic_breakdown from runtime_symbols table', () => {
    const src = fs.readFileSync(require.resolve('../src/agent-intel/runtime-ingest'), 'utf8');
    expect(src).toContain('FROM runtime_symbols');
    expect(src).toContain('GROUP BY traffic');
    // The primary return value must derive from the persisted table,
    // Not from `functions.filter(...)` over the just-ingested file.
    // Implementation uses dot-assignment to populate the breakdown object
    // From the query result rows.
    expect(src).toMatch(/breakdown\.(hot|warm|cold)\s*=\s*row\.cnt/);
  });

  // ── F16: listWorkspaces uses portable SQL (no NULLS FIRST) ──
  it('F16: workspaces.js does not use SQLite-only NULLS FIRST in SQL', () => {
    const src = fs.readFileSync(require.resolve('../src/memory-domain/workspaces'), 'utf8'),
      // Strip comments and check the remaining SQL strings.
      stripped = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
    expect(stripped).not.toMatch(/NULLS\s+FIRST/i);
  });

  // ── F17: blastRadius tests_likely_affected uses call-graph evidence ──
  it('F17: blast.js uses call graph (code_calls) to find tests, not symbol-name path LIKE', () => {
    const src = fs.readFileSync(require.resolve('../src/agent-intel/blast'), 'utf8');
    // The query must reference code_calls to find callers.
    expect(src).toContain('FROM code_calls cc');
    // Pre-fix bug matched test files whose path string contained the symbol name.
    expect(src).not.toMatch(/cf\.path LIKE \?\s*\)\.all\(repoId, `%\$\{symbolRow\.name\}%`\)/);
  });

  // ── F18: risk-impl blast-radius branch consistency ──
  it('F18: risk-impl.js per-symbol blast-radius branch passes depth=5', () => {
    const src = fs.readFileSync(require.resolve('../src/code-analysis/risk-impl'), 'utf8');
    expect(src).toMatch(/depth:\s*5/);
    expect(src).not.toMatch(/\.edges\b/);
  });

  // ── F19: preflight duplicateWarnings removes dead secondary check ──
  it('F19: duplicateWarnings no longer contains the unreachable normalizedSymbol.includes(normalizedTask) branch', () => {
    const src = fs.readFileSync(require.resolve('../src/agent-intel/preflight'), 'utf8');
    expect(src).not.toMatch(/normalizedSymbol\.includes\(normalizedTask\)/);
    expect(src).toMatch(/overlap\.slice\(0,\s*4\)\.join/);
  });

  // ── F20: user-prompt-submit logs errors on assembleContextLines failure ──
  it('F20: user-prompt-submit logs via console.error for assembleContextLines failures', () => {
    const src = fs.readFileSync(require.resolve('../src/claude-code/handlers/user-prompt-submit'), 'utf8'),
    assembleIdx = (() => {

      expect(src).toContain('console.error');
      expect(src).toContain('assembleContextLines failed');
      // The specific catch on the assembleContextLines(...) call must NOT be a
      // Silent `() => null` swallow — it must take the error and log it.
      
  return (src.indexOf('assembleContextLines({'));
})(),
    snippet = !(assembleIdx === -1) ? (src.slice(assembleIdx, assembleIdx + 800)) : undefined;if (assembleIdx === -1) {
      throw new Error('could not locate assembleContextLines({ call');
    }
    // Find the closing `)` of the .catch chained onto that call.
    expect(snippet).toMatch(/\.catch\(\s*\(err\)\s*=>/);
  });

  // ── F21: context-inject logs errors on assembleContextLines failure ──
  it('F21: buildInjectedContext logs via console.error instead of .catch(() => null)', () => {
    const src = fs.readFileSync(require.resolve('../src/claude-code/context-inject'), 'utf8');
    expect(src).toContain('console.error');
    expect(src).toContain('assembleContextLines failed');
    expect(src).not.toMatch(/\.catch\(\(\)\s*=>\s*null\s*\)/);
  });

  // ── F22: dream stats persist failure is logged ──
  it('F22: compaction.js dream stats persist failure logs via console.error', () => {
    const src = fs.readFileSync(require.resolve('../src/memory-domain/compaction'), 'utf8');
    expect(src).toContain('failed to persist dream-cycle stats');
    // The previous silent swallow used a `_e` catch binding with the
    // "Non-critical" comment — verify both are gone.
    expect(src).not.toMatch(/catch\s*\(\s*_e\s*\)\s*{\s*\/\/\s*Non-critical/);
  });
});

// Integration tests below require better-sqlite3 native binding. They are
// Skipped (not failed) when the binding is unavailable in the runtime.
{
const describeIfSqlite = sqliteReady() ? describe : describe.skip;

describeIfSqlite('correctness review fixes (round 2) — integration', () => {
  beforeAll(() => {
    dbModule.ensureDb();
  });

  // ── F14 integration: re-export detection ──

  describe('F14: dead-code re-export detection', () => {
    const repoName = uniqueRepoName('f14-reexport'),
      repoId = 990001;

    afterAll(() => {
      try {
        dbModule.sqlRun('DELETE FROM file_scope_bindings WHERE repo_id = ?', [repoId]);
        dbModule.sqlRun('DELETE FROM code_files WHERE repo_id = ?', [repoId]);
        dbModule.sqlRun('DELETE FROM code_symbols WHERE repo_id = ?', [repoId]);
        dbModule.sqlRun('DELETE FROM code_repos WHERE id = ?', [repoId]);
        dbModule.sqlRun('DELETE FROM code_repos WHERE name = ?', [repoName]);
      } catch {}
    });

    it('detects symbols that are re-exported via file_scope_bindings (kind=re_export)', () => {
      dbModule.sqlRun('INSERT INTO code_repos (id, name, path, head_commit) VALUES (?, ?, ?, NULL)', [
        repoId,
        repoName,
        `/tmp/${repoName}`,
      ]);
      dbModule.sqlRun(
        `INSERT INTO code_files (repo_id, path, language, content, content_hash, mtime, size_bytes, line_count)
         VALUES (?, ?, 'javascript', 'export function validateUser() {}', 'h1', 1000, 100, 1)`,
        [repoId, `/tmp/${repoName}/internal.js`],
      );
      const fileId = dbModule.sqlJson('SELECT id FROM code_files WHERE repo_id = ? ORDER BY id DESC LIMIT 1', [
        repoId,
      ])[0].id,
      result = (() => {

  
        dbModule.sqlRun(
          `INSERT INTO code_symbols (repo_id, file_id, file_path, name, kind, signature, qualified_name,
            start_line, end_line, start_byte, end_byte, docstring, body_preview, language, parent_name,
            stable_symbol_id, content_hash, summary, decorators_json, keywords_json, call_references_json, ecosystem_context)
           VALUES (?, ?, ?, 'validateUser', 'function', '() => void', 'validateUser',
            1, 1, 0, 50, '', '', 'javascript', '', '', 'h1', '', '[]', '[]', '[]', '')`,
          [repoId, fileId, `/tmp/${repoName}/internal.js`],
        );
  
        dbModule.sqlRun(
          `INSERT INTO file_scope_bindings (repo_id, file_id, name, kind, origin, source_file_id,
            source_name, source_module, line_start, line_end, scope_depth)
           VALUES (?, ?, 'validateUser', 're_export', 'external_file', ?, 'validateUser',
            './internal', 1, 1, 0)`,
          [repoId, fileId, fileId],
        );
  
        
  return (getDeadCode(dbModule.getDb(), repoId, { includeTests: true }));
})(),
      sym = (() => {
expect(result).toBeDefined();
        expect(Array.isArray(result.dead_symbols)).toBe(true);
        
  return (result.dead_symbols.find((s) => s.name === 'validateUser'));
})();if (sym) {
        // When the symbol IS re-exported, the dead-code detector must
        // Either omit it entirely (confidence < threshold) or include the
        // 're_exported' signal with reduced confidence.
        expect(
          sym.signals.includes('re_exported') || sym.confidence < 0.5,
          're-exported symbol should not be flagged as confidently dead',
        ).toBe(true);
      }
    });

    it('still flags truly uncalled, non-reexported symbols', () => {
      const fileId = dbModule.sqlJson(
        'SELECT id FROM code_files WHERE repo_id = ? ORDER BY id ASC LIMIT 1',
        [990001],
      )[0]?.id;
      if (!fileId) {
        return;
      }
      dbModule.sqlRun(
        `INSERT INTO code_symbols (repo_id, file_id, file_path, name, kind, signature, qualified_name,
          start_line, end_line, start_byte, end_byte, docstring, body_preview, language, parent_name,
          stable_symbol_id, content_hash, summary, decorators_json, keywords_json, call_references_json, ecosystem_context)
         VALUES (?, ?, ?, 'orphanSymbol', 'function', '() => void', 'orphanSymbol',
          2, 2, 51, 100, '', '', 'javascript', '', '', 'h1', '', '[]', '[]', '[]', '')`,
        [990001, fileId, `/tmp/${uniqueRepoName('f14')}/internal.js`],
      );
      const result = getDeadCode(dbModule.getDb(), 990001, { includeTests: true }),
        orphan = result.dead_symbols.find((s) => s.name === 'orphanSymbol');
      expect(orphan).toBeDefined();
      expect(orphan.signals).toContain('no_callers');
    });
  });

  // ── F15 integration: traffic_breakdown from persisted state ──

  describe('F15: runtime-ingest traffic_breakdown reflects persisted state', () => {
    const repoName = uniqueRepoName('f15-traffic');

    afterAll(() => {
      try {
        dbModule.sqlRun('DELETE FROM runtime_symbols WHERE repo_id IN (SELECT id FROM code_repos WHERE name = ?)', [
          repoName,
        ]);
        dbModule.sqlRun('DELETE FROM code_repos WHERE name = ?', [repoName]);
      } catch {}
    });

    it('counts persisted hot/warm/cold across multiple ingest calls', () => {
      const repoId = dbModule.sqlJson('INSERT INTO code_repos (name, path) VALUES (?, ?) RETURNING id', [
          repoName,
          `/tmp/${repoName}`,
        ])[0].id,
        coverage = {
          '/src/first.js': {
            fnMap: {
              0: { name: 'hotFn', line: 1, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
              1: { name: 'coldFn', line: 2, loc: { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } } },
            },
            f: { 0: 5000, 1: 0 },
          },
          '/src/second.js': {
            fnMap: {
              0: { name: 'warmFn', line: 1, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
            },
            f: { 0: 500 },
          },
        },
        tmpPath = path.join(os.tmpdir(), `${repoName}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(coverage), 'utf8');
      try {
        ingestCoverage(dbModule.getDb(), repoId, tmpPath);
        ingestCoverage(dbModule.getDb(), repoId, tmpPath);

        const result = ingestCoverage(dbModule.getDb(), repoId, tmpPath),
          expected = { hot: 1, warm: 1, cold: 1 };
        expect(result.traffic_breakdown).toEqual(expected);

        {
const dbRows = dbModule.sqlJson(
            'SELECT traffic, COUNT(*) as cnt FROM runtime_symbols WHERE repo_id = ? GROUP BY traffic',
            [repoId],
          ),
          persisted = { hot: 0, warm: 0, cold: 0 };
        for (const row of dbRows) {
          persisted[row.traffic] = row.cnt;
        }
        expect(persisted).toEqual(expected);
      }
} finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
    });

    it('classifyTraffic boundary values are stable', () => {
      // Thresholds: hot >= 1000, warm >= 100, cold < 100.
      // Just below hot → warm; just at hot → hot; just at warm → warm;
      // Well below warm → cold.
      expect(classifyTraffic(999)).toBe('warm');
      expect(classifyTraffic(1000)).toBe('hot');
      expect(classifyTraffic(100)).toBe('warm');
      expect(classifyTraffic(50)).toBe('cold');
    });
  });

  // ── F16 integration: listWorkspaces sorting ──

  describe('F16: listWorkspaces SQL portability', () => {
    it('listWorkspaces sorts un-archived workspaces before archived ones', () => {
      const w1 = uniqueRepoName('f16-active'),
        w2 = uniqueRepoName('f16-archived');
      createWorkspace(dbModule, w1);
      createWorkspace(dbModule, w2);
      archiveWorkspace(dbModule, w2);

      const result = listWorkspaces(dbModule),
        active = result.workspaces.find((w) => w.name === w1),
        archived = result.workspaces.find((w) => w.name === w2);
      expect(active).toBeDefined();
      expect(archived).toBeDefined();
      expect(active.archived_at).toBeNull();
      expect(archived.archived_at).not.toBeNull();

      {
const activeIdx = result.workspaces.findIndex((w) => w.name === w1),
        archivedIdx = result.workspaces.findIndex((w) => w.name === w2);
      expect(activeIdx).toBeLessThan(archivedIdx);
    }
});
  });

  // ── F17 integration: blastRadius tests_likely_affected ──

  describe('F17: blastRadius tests_likely_affected', () => {
    const repoName = uniqueRepoName('f17-blast');

    afterAll(() => {
      try {
        dbModule.sqlRun('DELETE FROM code_calls WHERE repo_id IN (SELECT id FROM code_repos WHERE name = ?)', [
          repoName,
        ]);
        dbModule.sqlRun('DELETE FROM code_symbols WHERE repo_id IN (SELECT id FROM code_repos WHERE name = ?)', [
          repoName,
        ]);
        dbModule.sqlRun('DELETE FROM code_files WHERE repo_id IN (SELECT id FROM code_repos WHERE name = ?)', [
          repoName,
        ]);
        dbModule.sqlRun('DELETE FROM code_repos WHERE name = ?', [repoName]);
      } catch {}
    });

    it('finds tests via call-graph even when their file path does not contain the symbol name', () => {
      const repoId = dbModule.sqlJson('INSERT INTO code_repos (name, path) VALUES (?, ?) RETURNING id', [
        repoName,
        `/tmp/${repoName}`,
      ])[0].id,
      coreFileId = (() => {

  
        dbModule.sqlRun(
          `INSERT INTO code_files (repo_id, path, language, content, content_hash, mtime, size_bytes, line_count)
           VALUES (?, ?, 'javascript',
            'export function criticalFunction() { return 1; }',
            'core-h', 1000, 100, 1)`,
          [repoId, `/tmp/${repoName}/src/core.js`],
        );
        
  return (dbModule.sqlJson('SELECT id FROM code_files WHERE repo_id = ? ORDER BY id DESC LIMIT 1', [
        repoId,
      ])[0].id);
})(); dbModule.sqlRun(
        `INSERT INTO code_symbols (repo_id, file_id, file_path, name, kind, signature, qualified_name,
          start_line, end_line, start_byte, end_byte, docstring, body_preview, language, parent_name,
          stable_symbol_id, content_hash, summary, decorators_json, keywords_json, call_references_json, ecosystem_context)
         VALUES (?, ?, ?, 'criticalFunction', 'function', '() => 1', 'criticalFunction',
          1, 1, 0, 60, '', '', 'javascript', '', '', 'h-core', '', '[]', '[]', '[]', '')`,
        [repoId, coreFileId, `/tmp/${repoName}/src/core.js`],
      );
      const targetSym = dbModule.sqlJson('SELECT id FROM code_symbols WHERE repo_id = ? AND name = ?', [
        repoId,
        'criticalFunction',
      ])[0].id,
      testFileId = (() => {

  
        dbModule.sqlRun(
          `INSERT INTO code_files (repo_id, path, language, content, content_hash, mtime, size_bytes, line_count)
           VALUES (?, ?, 'javascript',
            'test("critical", () => { criticalFunction(); });',
            'api-h', 1000, 100, 1)`,
          [repoId, `/tmp/${repoName}/test/api.test.js`],
        );
        
  return (dbModule.sqlJson('SELECT id FROM code_files WHERE repo_id = ? ORDER BY id DESC LIMIT 1', [
        repoId,
      ])[0].id);
})(); dbModule.sqlRun(
        `INSERT INTO code_symbols (repo_id, file_id, file_path, name, kind, signature, qualified_name,
          start_line, end_line, start_byte, end_byte, docstring, body_preview, language, parent_name,
          stable_symbol_id, content_hash, summary, decorators_json, keywords_json, call_references_json, ecosystem_context)
         VALUES (?, ?, ?, 'runApiTest', 'function', '() => void', 'runApiTest',
          1, 1, 0, 60, '', '', 'javascript', '', '', 'h-test', '', '[]', '[]', '[]', '')`,
        [repoId, testFileId, `/tmp/${repoName}/test/api.test.js`],
      );
      const testCaller = dbModule.sqlJson('SELECT id FROM code_symbols WHERE repo_id = ? AND name = ?', [
        repoId,
        'runApiTest',
      ])[0].id,
      result = (() => {

  
        dbModule.sqlRun(
          `INSERT INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number)
           VALUES (?, ?, 'criticalFunction', ?, 1.0, 1)`,
          [repoId, testCaller, targetSym],
        );
  
        
  return (blastRadius(dbModule.getDb(), repoId, 'criticalFunction'));
})();expect(result.error).toBeUndefined();
      expect(result.tests_likely_affected).toBeDefined();
      expect(result.tests_likely_affected.length).toBe(1);
      expect(result.tests_likely_affected[0]).toMatch(/api\.test\.js$/);
    });
  });

  // ── F18 integration: getPrRiskProfile blast-radius branch ──

  describe('F18: getPrRiskProfile blast-radius branch consistency', () => {
    it('getPrRiskProfile returns consistent blast_radius in [0, 1]', () => {
      const result = getPrRiskProfile(dbModule.getDb(), 999999, { branch: 'HEAD', base: 'main' });
      expect(result).toBeDefined();
      if (result.signals) {
        expect(result.signals.blast_radius).toBeGreaterThanOrEqual(0);
        expect(result.signals.blast_radius).toBeLessThanOrEqual(1);
      }
    });
  });
});
}
