// Audit fixes for code-analysis: dead-code direction, incremental call-graph scope,
// Per-file churn for hotspots, shared complexity scoring, blast-radius --depth.
// LAPIS_HOME is a per-file temp dir (test/setup-lapis-home.js); spawned CLIs inherit it.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  Database = require('better-sqlite3'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js');

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
}

function cli(...args) {
  const out = execFileSync(process.execPath, [STORE, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function openDb() {
  return new Database(path.join(process.env.LAPIS_HOME, '.pi', 'memory', 'memory.db'));
}

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-audit-ca-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

describe('code-analysis audit fixes', () => {
  const name = `audit-ca-${Date.now()}`;
  let dir;

  beforeAll(() => {
    dir = makeRepo({
      'index.js': "const { runA } = require('./lib/a');\nrunA();\n",
      'lib/a.js':
        "const { runB } = require('./b');\nfunction runA() {\n  return runB();\n}\nmodule.exports = { runA };\n",
      'lib/b.js':
        'function runB() {\n  if (globalThis.x) {\n    return externalLib(1);\n  }\n  return 2;\n}\n' +
        'function f1() { return f2(); }\nfunction f2() { return f3(); }\nfunction f3() { return f4(); }\nfunction f4() { return 4; }\n' +
        'module.exports = { runB, f1 };\n',
      'lib/c.js': 'function useLater() {\n  return later();\n}\nmodule.exports = { useLater };\n',
      'lib/d.js': 'function unrelated() {\n  return externalLib(2);\n}\nmodule.exports = { unrelated };\n',
      'package.json': JSON.stringify({ name: 'fx', bin: { fx: './tools/run.js' } }),
      'tools/run.js': 'function runTool() {\n  return 1;\n}\nrunTool();\n',
      'lib/café.js':
        'function cafeFn() {\n  if (globalThis.y) {\n    return 1;\n  }\n  return 2;\n}\nmodule.exports = { cafeFn };\n',
    });
    cli('index-repo', '--path', dir, '--name', name);
  }, 120000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dead-code walks imports forward from entry files (#3)', () => {
    const r = cli('dead-code', '--repo', name),
      data = r.data || r,
      deadPaths = data.dead_files.map((f) => f.path.replace(/\\/g, '/'));
    expect(deadPaths.some((p) => p.endsWith('lib/a.js'))).toBe(false);
    expect(deadPaths.some((p) => p.endsWith('lib/b.js'))).toBe(false);
    expect(data.dead_symbols.find((s) => s.name === 'runA')?.signals || []).not.toContain('unreachable_file');
  });

  it('dead-code treats package.json bin targets as entry files', () => {
    const r = cli('dead-code', '--repo', name),
      deadPaths = (r.data || r).dead_files.map((f) => f.path.replace(/\\/g, '/'));
    expect(deadPaths.some((p) => p.endsWith('tools/run.js'))).toBe(false);
  });

  it('churn writes per-file rows so hotspots is not empty (#13)', () => {
    cli('churn', '--repo', name, '--refresh');
    const r = cli('hotspots', '--repo', name),
      data = r.data || r;
    expect(data.hotspots.length).toBeGreaterThan(0);
    expect(data.hotspots.some((h) => h.name === 'runB')).toBe(true);
    // Non-ASCII file names must not come back git-quoted ("lib/caf\303\251.js").
    expect(data.hotspots.some((h) => h.name === 'cafeFn')).toBe(true);
  });

  it('blast-radius honours --depth (bonus)', () => {
    const count = (depth) => {
      const r = cli('blast-radius', '--repo', name, '--symbol', 'f4', '--depth', String(depth));
      return JSON.stringify(r.data || r).match(/"f[123]"/g)?.length || 0;
    };
    expect(count(1)).toBeLessThan(count(5));
  });

  it('incremental call graph resolves old callers of a new function, and skips unrelated files (#10)', async () => {
    // Add the missing callee to an existing file and reindex incrementally.
    fs.appendFileSync(path.join(dir, 'lib/d.js'), 'function later() {\n  return 1;\n}\n');
    cli('reindex-repo', '--repo', name, '--mode', 'incremental');
    let db = openDb();
    try {
      const edge = db
        .prepare(
          `SELECT cc.callee_symbol_id, callee.name AS callee FROM code_calls cc
           JOIN code_symbols caller ON caller.id = cc.caller_symbol_id
           LEFT JOIN code_symbols callee ON callee.id = cc.callee_symbol_id
           WHERE caller.name = 'useLater' AND cc.callee_name = 'later'`,
        )
        .get();
      expect(edge?.callee).toBe('later');
    } finally {
      db.close();
    }

    // An edit that defines no new names must only reprocess the edited file,
    // Even though other files hold unresolved (builtin/library) calls.
    const { createParserRegistry } = require('../src/code-index/parser-registry'),
      { buildCallGraphForFiles } = require('../src/code-analysis/incremental-builders');
    await createParserRegistry().ensureReady();
    db = openDb();
    try {
      const repoId = db.prepare('SELECT id FROM code_repos WHERE name = ?').get(name).id,
        aId = db.prepare("SELECT id FROM code_files WHERE repo_id = ? AND path LIKE '%a.js'").get(repoId).id,
        unresolvedFiles = db
          .prepare(
            `SELECT COUNT(DISTINCT s.file_id) AS n FROM code_calls cc JOIN code_symbols s ON s.id = cc.caller_symbol_id
             WHERE cc.repo_id = ? AND cc.callee_symbol_id IS NULL`,
          )
          .get(repoId).n,
        r = buildCallGraphForFiles(db, repoId, [aId], []);
      expect(unresolvedFiles).toBeGreaterThan(1);
      expect(r.filesAffected).toBe(1);
    } finally {
      db.close();
    }
  }, 120000);
});

describe('complexity scoring is shared by full and incremental builds (#19)', () => {
  it('produces identical rows for the same file', () => {
    const { buildComplexity } = require('../src/code-analysis/complexity-impl'),
      { buildComplexityForFiles } = require('../src/code-analysis/incremental-builders'),
      db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    const content =
        "function pick(a, b) {\n  const s = 'pickelse if';\n  if (a) {\n    return a ?? b;\n  } else if (b) {\n    return b ? 1 : 2;\n  }\n  return s;\n}\n",
      repoId = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)').run('cx', '/cx').lastInsertRowid,
      fileId = db
        .prepare(
          "INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, '/cx/a.js', 'javascript', ?, 'h')",
        )
        .run(repoId, content).lastInsertRowid;
    db.prepare(
      `INSERT INTO code_symbols (repo_id, file_id, name, kind, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name, signature)
       VALUES (?, ?, 'pick', 'function', '/cx/a.js', 1, 9, 0, ?, 'javascript', 'pick', 'function pick(a, b)')`,
    ).run(repoId, fileId, Buffer.byteLength(content));
    const rows = () =>
      db
        .prepare(
          'SELECT cyclomatic, nesting_depth, param_count, lines_of_code, assessment FROM symbol_complexity ORDER BY symbol_id',
        )
        .all();

    buildComplexity(db, repoId);
    const full = rows();
    buildComplexityForFiles(db, repoId, [fileId], []);
    expect(full).toHaveLength(1);
    expect(rows()).toEqual(full);
    db.close();
  });
});

describe('dependency cycles', () => {
  const { getDependencyCycles } = require('../src/code-analysis/import-graph-impl');

  function graphDb(edges) {
    const db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    const repoId = db.prepare("INSERT INTO code_repos (name, path) VALUES ('cy', '/cy')").run().lastInsertRowid,
      ids = new Map(),
      fileId = (p) => {
        if (!ids.has(p)) {
          ids.set(
            p,
            db
              .prepare(
                "INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, 'javascript', '', 'h')",
              )
              .run(repoId, p).lastInsertRowid,
          );
        }
        return ids.get(p);
      },
      ins = db.prepare(
        'INSERT INTO code_imports (repo_id, source_file_id, target_module, target_file_id) VALUES (?, ?, ?, ?)',
      );
    db.transaction(() => {
      for (const [a, b] of edges) {
        ins.run(repoId, fileId(a), b, fileId(b));
      }
    })();
    return { db, repoId };
  }

  it('finds separate cycles and ignores acyclic files', () => {
    const { db, repoId } = graphDb([
        ['a', 'b'],
        ['b', 'a'],
        ['c', 'd'],
        ['d', 'e'],
        ['e', 'c'],
        ['f', 'a'],
      ]),
      r = getDependencyCycles(db, repoId);
    expect(r.cycles.map((c) => c.files.slice().sort())).toEqual([
      ['c', 'd', 'e'],
      ['a', 'b'],
    ]);
    expect(r.total_circular_files).toBe(5);
    db.close();
  });

  it('handles a 20k-file import cycle without overflowing the stack', () => {
    const N = 20000,
      edges = Array.from({ length: N }, (_, i) => [`f${i}`, `f${(i + 1) % N}`]),
      { db, repoId } = graphDb(edges),
      r = getDependencyCycles(db, repoId);
    expect(r.cycles).toHaveLength(1);
    expect(r.cycles[0].size).toBe(N);
    db.close();
  }, 60000);
});

describe('pr-risk batch blast radius counts transitive callers', () => {
  it('scores a 3-deep caller chain, not just the direct caller (>20 changed symbols)', () => {
    const { getPrRiskProfile } = require('../src/code-analysis/risk-impl'),
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-risk-'));
    fs.writeFileSync(path.join(repoDir, 'a.js'), '1\n');
    git(repoDir, 'init', '-q');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(repoDir, 'a.js'), '2\n');
    git(repoDir, 'commit', '-q', '-am', 'two');

    const db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    const repoId = db.prepare("INSERT INTO code_repos (name, path) VALUES ('risk', ?)").run(repoDir).lastInsertRowid,
      file = (p) =>
        db
          .prepare(
            "INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, 'javascript', '', 'h')",
          )
          .run(repoId, p).lastInsertRowid,
      aPath = path.join(repoDir, 'a.js'),
      bPath = path.join(repoDir, 'b.js'),
      aId = file(aPath),
      bId = file(bPath),
      sym = (fileId, filePath, name) =>
        db
          .prepare(
            `INSERT INTO code_symbols (repo_id, file_id, name, kind, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name)
             VALUES (?, ?, ?, 'function', ?, 1, 1, 0, 1, 'javascript', ?)`,
          )
          .run(repoId, fileId, name, filePath, name).lastInsertRowid,
      call = (caller, callee, name) =>
        db
          .prepare(
            'INSERT INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id) VALUES (?, ?, ?, ?)',
          )
          .run(repoId, caller, name, callee);
    const changed = Array.from({ length: 21 }, (_, i) => sym(aId, aPath, `s${i}`)),
      c1 = sym(bId, bPath, 'c1'),
      c2 = sym(bId, bPath, 'c2'),
      c3 = sym(bId, bPath, 'c3');
    call(c1, changed[0], 's0');
    call(c2, c1, 'c1');
    call(c3, c2, 'c2');

    const r = getPrRiskProfile(db, repoId, { base: 'HEAD~1', branch: 'HEAD' });
    expect(r.changed_symbols).toBe(21);
    expect(r.signals.blast_radius).toBe(0.06); // 3 callers / BLAST_RADIUS_NORMALIZER 50
    db.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });
});
