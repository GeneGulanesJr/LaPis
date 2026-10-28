// Analysis on top of the code index: shared full/incremental call-graph builder,
// No fake self-call edges, repo-relative dead-code path rules, coding-context by
// Symbol id, deduped recursive CTEs with a clamped depth, and anchored deps --file.
// LAPIS_HOME is a per-file temp dir (test/setup-lapis-home.js); spawned CLIs inherit it.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  Database = require('better-sqlite3'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js'),
  CYCLE = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
}

function cli(...args) {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [STORE, ...args], { encoding: 'utf8', timeout: 60000, stdio: 'pipe' }).trim(),
    );
  } catch (e) {
    // Analysis errors exit non-zero with a JSON error body.
    return JSON.parse((e.stdout || e.stderr || '').trim());
  }
}

function openDb() {
  return new Database(path.join(process.env.LAPIS_HOME, '.pi', 'memory', 'memory.db'));
}

describe('analysis on top of the code index', () => {
  const name = `analysis-${Date.now()}`;
  let dir;

  beforeAll(() => {
    // The repo root contains "latest": path rules must not see "test" in it.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-latest-'));
    const files = {
      'index.js':
        "const { useOne } = require('./lib/dup1');\nconst { useTwo } = require('./lib/dup2');\n" +
        "const { run } = require('./lib/guarded');\nconst { c1 } = require('./lib/cycle');\nuseOne();\nuseTwo();\nrun();\nc1();\n",
      'lib/dup1.js':
        'function helper() {\n  return 1;\n}\nfunction useOne() {\n  return helper();\n}\nmodule.exports = { useOne };\n',
      'lib/dup2.js':
        'function helper() {\n  return 2;\n}\nfunction useTwo() {\n  return helper();\n}\nmodule.exports = { useTwo };\n',
      'lib/guarded.js':
        "const rm = require('./read-model');\nfunction guard() {\n  return 1;\n}\nfunction run() {\n  return guard() + rm.v;\n}\nmodule.exports = { run };\n",
      'lib/read-model.js': 'function guard() {\n  return 2;\n}\nmodule.exports = { guard, v: 1 };\n',
      'lib/orphan.js': 'function orphanLeaf() {\n  return 1;\n}\nmodule.exports = { orphanLeaf };\n',
      'lib/domain.js': 'function domainThing() {\n  return 1;\n}\nmodule.exports = { domainThing };\n',
      // Six mutually recursive functions: every one calls all the others.
      'lib/cycle.js': `${CYCLE.map(
        (fn) =>
          `function ${fn}(n) {\n  if (n) {\n    return ${CYCLE.filter((o) => o !== fn)
            .map((o) => `${o}(n - 1)`)
            .join(' + ')};\n  }\n  return 0;\n}\n`,
      ).join('')}module.exports = { ${CYCLE.join(', ')} };\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');
    cli('index-repo', '--path', dir, '--name', name);
  }, 120000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('full and incremental call-graph builds produce identical edges', async () => {
    await require('../src/code-index/parser-registry').createParserRegistry().ensureReady();
    const { buildCallGraph } = require('../src/code-analysis/call-graph-impl'),
      { buildCallGraphForFiles } = require('../src/code-analysis/incremental-builders'),
      db = openDb();
    try {
      const repoId = db.prepare('SELECT id FROM code_repos WHERE name = ?').get(name).id,
        fileIds = db
          .prepare('SELECT id FROM code_files WHERE repo_id = ?')
          .all(repoId)
          .map((r) => r.id),
        edgesAfter = (build) => {
          build();
          return db
            .prepare(
              `SELECT caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number FROM code_calls
               WHERE repo_id = ? ORDER BY caller_symbol_id, callee_name, line_number`,
            )
            .all(repoId);
        },
        full = edgesAfter(() => buildCallGraph(db, repoId)),
        incremental = edgesAfter(() => buildCallGraphForFiles(db, repoId, fileIds, []));
      expect(full.length).toBeGreaterThan(0);
      expect(incremental).toEqual(full);
    } finally {
      db.close();
    }
  });

  it('records no self-call edge for a function that calls nothing', () => {
    const db = openDb();
    try {
      const self = db
        .prepare(
          `SELECT COUNT(*) AS n FROM code_calls cc JOIN code_symbols s ON s.id = cc.caller_symbol_id
           WHERE s.name = 'orphanLeaf' AND cc.callee_symbol_id = cc.caller_symbol_id`,
        )
        .get().n;
      expect(self).toBe(0);
    } finally {
      db.close();
    }
  });

  it('dead-code reports an unused leaf under a repo root containing "latest", and domain.js is no entry file', () => {
    const data = cli('dead-code', '--repo', name, '--min-confidence', '0.1'),
      r = data.data || data;
    expect(r.dead_symbols.map((s) => s.name)).toContain('orphanLeaf');
    expect(r.dead_files.map((f) => f.path.replace(/\\/g, '/')).some((p) => p.endsWith('lib/domain.js'))).toBe(true);
  });

  it('coding-context uses the --file symbol for callers and blast radius', () => {
    const data = cli('coding-context', '--repo', name, '--symbol', 'helper', '--file', 'lib/dup2.js'),
      r = data.data || data,
      text = JSON.stringify(r.callers);
    expect(text).toContain('useTwo');
    expect(text).not.toContain('useOne');
    expect(r.blast_radius).not.toBeNull();
  });

  it('call hierarchy on a cycle returns each caller once, and the CLI clamps --depth', () => {
    const { getCallHierarchy } = require('../src/code-analysis/call-graph-impl'),
      db = openDb(),
      depthOf = (d) => {
        const data = cli('call-hierarchy', '--repo', name, '--symbol', 'c1', '--depth', d);
        return (data.data || data).depth;
      };
    try {
      const repoId = db.prepare('SELECT id FROM code_repos WHERE name = ?').get(name).id,
        { callers } = getCallHierarchy(db, repoId, { symbol: 'c1', direction: 'callers', depth: 8 }),
        { callees } = getCallHierarchy(db, repoId, { symbol: 'c1', direction: 'callees', depth: 8 });
      expect(callers.map((c) => c.name).sort()).toEqual(CYCLE);
      expect(callees.map((c) => c.callee_name).sort()).toEqual(CYCLE);
    } finally {
      db.close();
    }
    expect(depthOf('abc')).toBe(3);
    expect(depthOf('99')).toBe(5);
  });

  it('deps --file matches a whole path suffix with either separator', () => {
    const edges = (file) => {
      const data = cli('import-graph', '--repo', name, '--file', file);
      return data.data || data;
    };
    expect(edges('lib/guarded.js').edges.length).toBeGreaterThan(0);
    expect(edges('dex.js').error).toMatch(/File not found/);
  });
});
