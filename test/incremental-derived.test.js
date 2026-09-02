const fs = require('fs');
const _os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const {
  buildImportGraphForFiles,
  buildCallGraphForFiles: _buildCallGraphForFiles,
  buildComplexityForFiles,
} = require('../src/code-analysis/legacy-core');
const { rebuildDerivedIndexes } = require('../src/code-index/incremental-indexer'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js');

let cliAvailable = false;
try {
  const result = execSync(`node "${STORE}" list-code-repos`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    parsed = JSON.parse(result.trim());
  cliAvailable = parsed && typeof parsed.total === 'number';
} catch {}

function run(cmd) {
  const out = execSync(`node "${STORE}" ${cmd}`, {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function _runFail(cmd) {
  try {
    execSync(`node "${STORE}" ${cmd}`, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    try {
      return JSON.parse((err.stderr || err.stdout || '').trim());
    } catch {
      return { error: err.stderr || err.message };
    }
  }
}

function writeTmpRepo(repoPath, files) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

const REPO_PREFIX = 'test-incr-derived';

function repoName(suffix) {
  return `${REPO_PREFIX}-${suffix}-${Date.now()}`;
}

function cleanupRepo(name) {
  try {
    execSync(`node "${STORE}" remove-code-repo --repo ${name}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {}
}

function makeMockDb(tables) {
  const data = JSON.parse(JSON.stringify(tables)),
    stmts = [];

  function prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    stmts.push(normalized);

    return {
      run(...params) {
        if (normalized.startsWith('DELETE FROM code_imports')) {
          data.code_imports = (data.code_imports || []).filter((row) => {
            if (params.length === 1 && normalized.includes('repo_id = ?')) {
              return row.repo_id !== params[0];
            }
            return true;
          });
        }
        if (normalized.startsWith('DELETE FROM code_calls')) {
          data.code_calls = (data.code_calls || []).filter((row) => {
            if (params.length === 1 && normalized.includes('repo_id = ?')) {
              return row.repo_id !== params[0];
            }
            return true;
          });
        }
        if (normalized.startsWith('DELETE FROM symbol_complexity')) {
          data.symbol_complexity = (data.symbol_complexity || []).filter((_row) => {
            if (normalized.includes('file_id IN')) {
              return false;
            }
            return true;
          });
        }
        if (normalized.startsWith('INSERT OR IGNORE INTO code_imports')) {
          (data.code_imports = data.code_imports || []).push({
            repo_id: params[0],
            source_file_id: params[1],
            target_module: params[2],
            target_file_id: params[3],
            import_type: params[4],
            line_number: params[5],
          });
        }
        if (normalized.startsWith('INSERT OR IGNORE INTO code_calls')) {
          (data.code_calls = data.code_calls || []).push({
            repo_id: params[0],
            caller_symbol_id: params[1],
            callee_name: params[2],
            callee_symbol_id: params[3],
            confidence: params[4],
            line_number: params[5],
          });
        }
        if (normalized.startsWith('INSERT OR REPLACE INTO symbol_complexity')) {
          (data.symbol_complexity = data.symbol_complexity || []).push({
            symbol_id: params[0],
            cyclomatic: params[1],
            nesting_depth: params[2],
            param_count: params[3],
            lines_of_code: params[4],
            assessment: params[5],
          });
        }
      },
      get(...params) {
        if (normalized.includes('SELECT id, path, content FROM code_files WHERE id = ?')) {
          return (data.code_files || []).find((f) => f.id === params[0]) || undefined;
        }
        if (normalized.includes('SELECT content FROM code_files WHERE id = ?')) {
          const f = (data.code_files || []).find((cf) => cf.id === params[0]);
          return f ? { content: f.content } : undefined;
        }
        return undefined;
      },
      all(...params) {
        if (
          normalized.includes('SELECT DISTINCT source_file_id FROM code_imports') &&
          normalized.includes('target_file_id IN')
        ) {
          return (data.code_imports || [])
            .filter((imp) => imp.repo_id === params[0] && params.slice(1).includes(imp.target_file_id))
            .map((imp) => ({ source_file_id: imp.source_file_id }));
        }
        if (
          normalized.includes('SELECT DISTINCT s.file_id FROM code_calls') &&
          normalized.includes('callee_symbol_id IS NULL')
        ) {
          const nullCallees = (data.code_calls || []).filter(
              (cc) => cc.repo_id === params[0] && cc.callee_symbol_id == null,
            ),
            callerIds = nullCallees.map((cc) => cc.caller_symbol_id),
            symbols = data.code_symbols || [];
          return [...new Set(symbols.filter((s) => callerIds.includes(s.id)).map((s) => s.file_id))].map((fid) => ({
            file_id: fid,
          }));
        }
        if (normalized.includes('FROM code_symbols WHERE repo_id = ?') && !normalized.includes('file_id IN')) {
          return (data.code_symbols || []).filter((s) => s.repo_id === params[0]);
        }
        if (normalized.includes('FROM code_symbols WHERE repo_id = ?') && normalized.includes('file_id IN')) {
          return (data.code_symbols || []).filter(
            (s) => s.repo_id === params[0] && params.slice(1).includes(s.file_id),
          );
        }
        if (normalized.includes('FROM code_files WHERE repo_id = ?') && !normalized.includes('file_id IN')) {
          return (data.code_files || []).filter((f) => f.repo_id === params[0]);
        }
        return [];
      },
    };
  }

  return {
    prepare: (...args) => prepare(...args),
    exec: () => {},
    transaction: (fn) => fn,
    _data: data,
    _stmts: stmts,
  };
}

const describeIntegration = cliAvailable ? describe : describe.skip;

describe('incremental derived graph builders', () => {
  describe('buildImportGraphForFiles', () => {
    it('returns early with zero edges when no files changed', () => {
      const db = makeMockDb({}),
        result = buildImportGraphForFiles(db, 1, [], []);
      expect(result.success).toBe(true);
      expect(result.edges).toBe(0);
      expect(result.incremental).toBe(true);
    });

    it('rebuilds imports only for changed files and their importers', () => {
      const db = makeMockDb({
          code_files: [
            {
              id: 1,
              repo_id: 1,
              path: '/repo/a.js',
              content: 'const { b } = require("./b");\nfunction main() {\n  b();\n}',
            },
            {
              id: 2,
              repo_id: 1,
              path: '/repo/b.js',
              content: 'function b() { return 42; }\nmodule.exports = { b };',
            },
            {
              id: 3,
              repo_id: 1,
              path: '/repo/c.js',
              content: 'function c() { return 99; }',
            },
          ],
          code_imports: [
            {
              repo_id: 1,
              source_file_id: 1,
              target_module: './b',
              target_file_id: 2,
              import_type: 'static',
              line_number: 1,
            },
          ],
        }),
        result = buildImportGraphForFiles(db, 1, [2], []);
      expect(result.success).toBe(true);
      expect(result.incremental).toBe(true);
      expect(result.filesAffected).toBeGreaterThanOrEqual(1);

      const imports = db._data.code_imports,
        sourceIds = imports.map((imp) => imp.source_file_id);
      expect(sourceIds).not.toContain(3);
    });

    it('handles deleted files by removing their import edges', () => {
      const db = makeMockDb({
          code_files: [{ id: 1, repo_id: 1, path: '/repo/a.js', content: 'function a() {}' }],
          code_imports: [
            {
              repo_id: 1,
              source_file_id: 2,
              target_module: './deleted',
              target_file_id: 2,
              import_type: 'static',
              line_number: 1,
            },
          ],
        }),
        result = buildImportGraphForFiles(db, 1, [], [2]);
      expect(result.success).toBe(true);
      expect(result.incremental).toBe(true);
    });
  });

  describe('buildComplexityForFiles', () => {
    it('returns early with zero symbols when no files changed', () => {
      const db = makeMockDb({}),
        result = buildComplexityForFiles(db, 1, [], []);
      expect(result.success).toBe(true);
      expect(result.symbols).toBe(0);
      expect(result.incremental).toBe(true);
    });

    it('computes complexity only for symbols in changed files', () => {
      const symbols = [
          {
            id: 10,
            repo_id: 1,
            file_id: 1,
            name: 'complex',
            kind: 'function',
            signature: 'function complex()',
            start_byte: 0,
            end_byte: 100,
            start_line: 1,
            end_line: 7,
          },
        ],
        files = [
          {
            id: 1,
            repo_id: 1,
            path: '/repo/a.js',
            content:
              'function complex() {\n  if (x) {\n    for (let i = 0; i < 10; i++) {\n      if (y) { a(); }\n    }\n  }\n}',
          },
        ],
        queries = [],
        insertedRows = [],
        deletedForFileIds = [],
        db = {
          prepare(sql) {
            const n = sql.replace(/\s+/g, ' ').trim();
            queries.push(n);
            return {
              run(...params) {
                if (n.startsWith('DELETE FROM symbol_complexity')) {
                  if (n.includes('file_id IN')) {
                    deletedForFileIds.push(...params);
                  }
                }
                if (n.startsWith('INSERT OR REPLACE INTO symbol_complexity')) {
                  insertedRows.push(params);
                }
              },
              get() {
                return undefined;
              },
              all(...params) {
                if (n.includes('FROM code_symbols cs JOIN code_files cf')) {
                  const repoId = params[0],
                    fileIds = params.slice(1);
                  return symbols
                    .filter((s) => s.repo_id === repoId && fileIds.includes(s.file_id))
                    .map((s) => {
                      const f = files.find((fi) => fi.id === s.file_id);
                      return { ...s, file_content: f ? f.content : null };
                    });
                }
                return [];
              },
            };
          },
          exec() {},
          transaction(fn) {
            return fn;
          },
        },
        result = buildComplexityForFiles(db, 1, [1], []);
      expect(result.success).toBe(true);
      expect(result.incremental).toBe(true);
      expect(result.symbols).toBe(1);
      expect(insertedRows.length).toBe(1);
      expect(insertedRows[0][0]).toBe(10);
      expect(insertedRows[0][1]).toBeGreaterThanOrEqual(1);
    });

    it('deletes complexity for deleted file symbols without recomputing', () => {
      const db = makeMockDb({
          code_files: [],
          code_symbols: [],
          symbol_complexity: [
            { symbol_id: 10, cyclomatic: 5, nesting_depth: 2, param_count: 1, lines_of_code: 10, assessment: 'medium' },
          ],
        }),
        result = buildComplexityForFiles(db, 1, [], [1]);
      expect(result.success).toBe(true);
      expect(result.symbols).toBe(0);
    });
  });

  describe('rebuildDerivedIndexes', () => {
    it('uses incremental path when changedFileIds and deletedFileIds are provided', () => {
      const db = makeMockDb({
          code_files: [{ id: 1, repo_id: 1, path: '/repo/a.js', content: 'function a() { return 1; }' }],
          code_symbols: [
            {
              id: 10,
              repo_id: 1,
              file_id: 1,
              name: 'a',
              kind: 'function',
              start_byte: 0,
              end_byte: 28,
              start_line: 1,
              end_line: 1,
            },
          ],
        }),
        result = rebuildDerivedIndexes(db, 1, {}, 1, 1, 1, [1], []);
      expect(result.derived_scope).toBe('file');
    });

    it('uses repo-wide path when file IDs are not provided', () => {
      const db = makeMockDb({
          code_files: [{ id: 1, repo_id: 1, path: '/repo/a.js', content: 'function a() { return 1; }' }],
          code_symbols: [
            {
              id: 10,
              repo_id: 1,
              file_id: 1,
              name: 'a',
              kind: 'function',
              start_byte: 0,
              end_byte: 28,
              start_line: 1,
              end_line: 1,
            },
          ],
        }),
        result = rebuildDerivedIndexes(db, 1, {}, 1, 1, 1);
      expect(result.derived_scope).toBe('repo');
    });
  });
});

describeIntegration('incremental derived rebuild integration', () => {
  describe('changed-file path', () => {
    const name = repoName('changed');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-incr-changed-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'a.js': 'function alpha() { return 1; }',
        'b.js': 'function beta() { return 2; }',
        'c.js': 'function gamma() { return 3; }',
      });
      run(`index-repo --path "${tmpRepo}" --name ${name}`);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('reports file-level derived_scope after incremental reindex', () => {
      fs.writeFileSync(path.join(tmpRepo, 'a.js'), 'function alphaV2() { return 11; }');
      const result = run(`reindex-repo --repo ${name} --mode incremental`);
      expect(result.success).toBe(true);
      expect(result.derived_scope).toBe('file');
      expect(result.files_reindexed).toBeGreaterThanOrEqual(1);
    });

    it('still resolves imports correctly after incremental derived rebuild', () => {
      const graph = run(`import-graph --repo ${name}`),
        edges = graph.edges || graph.data?.edges;
      expect(Array.isArray(edges)).toBe(true);
    });
  });

  describe('renamed-file path', () => {
    const name = repoName('renamed');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-incr-renamed-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'src/util.js': 'function util() { return 1; }\nmodule.exports = { util };',
        'src/main.js': 'const { util } = require("./util");\nfunction main() { return util(); }',
      });
      run(`index-repo --path "${tmpRepo}" --name ${name}`);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('handles renamed files in incremental reindex with derived_scope file', () => {
      fs.renameSync(path.join(tmpRepo, 'src', 'util.js'), path.join(tmpRepo, 'src', 'helpers.js'));
      const result = run(`reindex-repo --repo ${name} --mode incremental`);
      expect(result.success).toBe(true);
      expect(result.derived_scope).toBe('file');
    });
  });

  describe('deleted-file path', () => {
    const name = repoName('deleted');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-incr-deleted-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'x.js': 'function x() { return 1; }',
        'y.js': 'function y() { return 2; }',
        'z.js': 'function z() { return 3; }',
      });
      run(`index-repo --path "${tmpRepo}" --name ${name}`);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('handles deleted files in incremental reindex', () => {
      const yPath = path.join(tmpRepo, 'y.js');
      if (!fs.existsSync(yPath)) {
        fs.writeFileSync(yPath, 'function y() { return 2; }');
        run(`reindex-repo --repo ${name} --mode incremental`);
      }
      fs.unlinkSync(yPath);
      const result = run(`reindex-repo --repo ${name} --mode incremental`);
      expect(result.success).toBe(true);
      expect(result.files_removed).toBeGreaterThanOrEqual(1);
      expect(result.derived_scope).toBe('file');
    });

    it('search no longer returns symbols from deleted file', () => {
      const search = run(`search-code --query y --repo ${name}`);
      expect(search.results.every((r) => !r.file.includes('y.js'))).toBe(true);
    });
  });

  describe('full reindex fallback', () => {
    const name = repoName('full-fallback');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-incr-full-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'a.js': 'function a() { return 1; }',
        'b.js': 'function b() { return 2; }',
      });
      run(`index-repo --path "${tmpRepo}" --name ${name}`);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('full mode rebuilds all derived indexes repo-wide', () => {
      const result = run(`reindex-repo --repo ${name} --mode full`);
      expect(result.success).toBe(true);
      expect(typeof result.import_edges).toBe('number');
      expect(typeof result.call_edges).toBe('number');
      expect(typeof result.complexity_symbols).toBe('number');
    });
  });
});

describeIntegration('health reporting with stale state', () => {
  const name = repoName('health');
  let tmpRepo;

  beforeAll(() => {
    tmpRepo = path.join('/tmp', `test-incr-health-${Date.now()}`);
    writeTmpRepo(tmpRepo, { 'h.js': 'function h() {}' });
    run(`index-repo --path "${tmpRepo}" --name ${name}`);
  });

  afterAll(() => {
    cleanupRepo(name);
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('reports health accurately after incremental reindex', () => {
    fs.writeFileSync(path.join(tmpRepo, 'h.js'), 'function hV2() {}');
    run(`reindex-repo --repo ${name} --mode incremental`);

    const health = run(`health-code-repo --repo ${name}`);
    expect(health.ok).toBe(true);
    expect(health.stale).toBe(false);
    expect(typeof health.health_score).toBe('number');
  });
});
