// Tests for propagation-impl: getAffectedGraph
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3'),
  TMP_DB = path.join('/tmp', 'propagation-test.db');

let db, repoId;

function setupPropagationDb() {
  if (fs.existsSync(TMP_DB)) {
    fs.unlinkSync(TMP_DB);
  }
  db = new Database(TMP_DB);

  db.exec(`CREATE TABLE code_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, path TEXT)`);
  db.exec(
    `CREATE TABLE code_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, path TEXT, language TEXT, content TEXT, content_hash TEXT)`,
  );
  db.exec(`CREATE TABLE code_symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, file_id INTEGER, name TEXT, kind TEXT,
    signature TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER, start_byte INTEGER,
    end_byte INTEGER, docstring TEXT DEFAULT '', body_preview TEXT DEFAULT '', language TEXT NOT NULL,
    parent_name TEXT DEFAULT '', qualified_name TEXT NOT NULL, stable_symbol_id TEXT DEFAULT '',
    content_hash TEXT DEFAULT '', summary TEXT DEFAULT '', decorators_json TEXT DEFAULT '[]',
    keywords_json TEXT DEFAULT '[]', call_references_json TEXT DEFAULT '[]',
    ecosystem_context TEXT DEFAULT '', indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE code_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, source_file_id INTEGER,
    target_module TEXT, target_file_id INTEGER, import_type TEXT DEFAULT 'static', line_number INTEGER
  )`);
  db.exec(`CREATE TABLE code_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, caller_symbol_id INTEGER,
    callee_name TEXT, callee_symbol_id INTEGER, confidence REAL DEFAULT 1.0, line_number INTEGER
  )`);
  db.exec(`CREATE TABLE code_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, source_symbol_id INTEGER,
    target_symbol_id INTEGER, source_file_id INTEGER, target_file_id INTEGER,
    kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, line_number INTEGER
  )`);
  db.exec(`CREATE TABLE file_cochange (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, file_a_id INTEGER, file_b_id INTEGER,
    co_commit_count INTEGER DEFAULT 0, strength REAL DEFAULT 0, window_days INTEGER DEFAULT 90
  )`);

  const insertRepo = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)'),
    result = insertRepo.run('test-repo', '/tmp/test');
  repoId = Number(result.lastInsertRowid);

  return { db, repoId };
}

afterEach(() => {
  if (db) {
    db.close();
  }
  if (fs.existsSync(TMP_DB)) {
    fs.unlinkSync(TMP_DB);
  }
});

describe('getAffectedGraph', () => {
  it('should find callers via code_calls', () => {
    const { db: testDb, repoId: rid } = setupPropagationDb();
    const { getAffectedGraph } = require('../src/code-analysis/propagation-impl'),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertSymbol = testDb.prepare(
        `INSERT INTO code_symbols (repo_id, file_id, name, kind, signature, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertCall = testDb.prepare(
        'INSERT INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence) VALUES (?, ?, ?, ?, ?)',
      ),
      fLib = insertFile.run(rid, 'lib.js', 'javascript', '', ''),
      fConsumer = insertFile.run(rid, 'consumer.js', 'javascript', '', ''),
      callee = insertSymbol.run(
        rid,
        Number(fLib.lastInsertRowid),
        'helper',
        'function',
        'function helper()',
        'lib.js',
        1,
        5,
        0,
        50,
        'javascript',
        'helper',
      ),
      caller = insertSymbol.run(
        rid,
        Number(fConsumer.lastInsertRowid),
        'main',
        'function',
        'function main()',
        'consumer.js',
        1,
        5,
        0,
        50,
        'javascript',
        'main',
      );

    insertCall.run(rid, Number(caller.lastInsertRowid), 'helper', Number(callee.lastInsertRowid), 1.0);

    const result = getAffectedGraph(testDb, rid, { symbol: 'helper' });
    expect(result.affected_files.length).toBeGreaterThanOrEqual(1);
    expect(result.affected_files.some((f) => f.path === 'consumer.js')).toBe(true);
    expect(result.affected_symbols.some((s) => s.name === 'main')).toBe(true);
  });

  it('should find importers via code_imports', () => {
    const { db: testDb, repoId: rid } = setupPropagationDb();
    const { getAffectedGraph } = require('../src/code-analysis/propagation-impl'),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertImport = testDb.prepare(
        'INSERT INTO code_imports (repo_id, source_file_id, target_module, target_file_id) VALUES (?, ?, ?, ?)',
      ),
      fLib = insertFile.run(rid, 'lib.js', 'javascript', '', ''),
      fConsumer = insertFile.run(rid, 'consumer.js', 'javascript', '', '');
    insertImport.run(rid, Number(fConsumer.lastInsertRowid), './lib', Number(fLib.lastInsertRowid));

    const result = getAffectedGraph(testDb, rid, { file: 'lib.js' });
    expect(result.affected_files.some((f) => f.path === 'consumer.js')).toBe(true);
  });

  it('should find extends relations', () => {
    const { db: testDb, repoId: rid } = setupPropagationDb();
    const { getAffectedGraph } = require('../src/code-analysis/propagation-impl'),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertSymbol = testDb.prepare(
        `INSERT INTO code_symbols (repo_id, file_id, name, kind, signature, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertRelation = testDb.prepare(
        'INSERT INTO code_relations (repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind, weight) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      fBase = insertFile.run(rid, 'base.js', 'javascript', '', ''),
      fChild = insertFile.run(rid, 'child.js', 'javascript', '', ''),
      baseSym = insertSymbol.run(
        rid,
        Number(fBase.lastInsertRowid),
        'Base',
        'class',
        'class Base',
        'base.js',
        1,
        5,
        0,
        50,
        'javascript',
        'Base',
      ),
      childSym = insertSymbol.run(
        rid,
        Number(fChild.lastInsertRowid),
        'Child',
        'class',
        'class Child extends Base',
        'child.js',
        1,
        5,
        0,
        50,
        'javascript',
        'Child',
      );

    insertRelation.run(
      rid,
      Number(childSym.lastInsertRowid),
      Number(baseSym.lastInsertRowid),
      Number(fChild.lastInsertRowid),
      Number(fBase.lastInsertRowid),
      'extends',
      1.0,
    );

    const result = getAffectedGraph(testDb, rid, { symbol: 'Base' });
    expect(result.affected_files.some((f) => f.path === 'child.js')).toBe(true);
    expect(result.affected_files.some((f) => f.signals.includes('extends'))).toBe(true);
  });

  it('should decay reachability with distance', () => {
    const { db: testDb, repoId: rid } = setupPropagationDb();
    const { getAffectedGraph } = require('../src/code-analysis/propagation-impl'),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertSymbol = testDb.prepare(
        `INSERT INTO code_symbols (repo_id, file_id, name, kind, signature, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertCall = testDb.prepare(
        'INSERT INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence) VALUES (?, ?, ?, ?, ?)',
      ),
      f1 = insertFile.run(rid, 'a.js', 'javascript', '', ''),
      f2 = insertFile.run(rid, 'b.js', 'javascript', '', ''),
      f3 = insertFile.run(rid, 'c.js', 'javascript', '', ''),
      symD = insertSymbol.run(
        rid,
        Number(f1.lastInsertRowid),
        'd',
        'function',
        'function d()',
        'a.js',
        1,
        5,
        0,
        50,
        'javascript',
        'd',
      ),
      symC = insertSymbol.run(
        rid,
        Number(f1.lastInsertRowid),
        'c',
        'function',
        'function c()',
        'a.js',
        1,
        5,
        0,
        50,
        'javascript',
        'c',
      ),
      symB = insertSymbol.run(
        rid,
        Number(f2.lastInsertRowid),
        'b',
        'function',
        'function b()',
        'b.js',
        1,
        5,
        0,
        50,
        'javascript',
        'b',
      ),
      symA = insertSymbol.run(
        rid,
        Number(f3.lastInsertRowid),
        'a',
        'function',
        'function a()',
        'c.js',
        1,
        5,
        0,
        50,
        'javascript',
        'a',
      );

    insertCall.run(rid, Number(symA.lastInsertRowid), 'b', Number(symB.lastInsertRowid), 1.0);
    insertCall.run(rid, Number(symB.lastInsertRowid), 'c', Number(symC.lastInsertRowid), 1.0);
    insertCall.run(rid, Number(symC.lastInsertRowid), 'd', Number(symD.lastInsertRowid), 1.0);

    const result = getAffectedGraph(testDb, rid, { symbol: 'd' }),
      fileB = result.affected_files.find((f) => f.path === 'b.js'),
      fileC = result.affected_files.find((f) => f.path === 'c.js');
    expect(fileB).toBeDefined();
    expect(fileC).toBeDefined();
    expect(fileB.reachability).toBeGreaterThan(fileC.reachability);
  });

  it('should include cochange signal', () => {
    const { db: testDb, repoId: rid } = setupPropagationDb();
    const { getAffectedGraph } = require('../src/code-analysis/propagation-impl'),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertCochange = testDb.prepare(
        'INSERT INTO file_cochange (repo_id, file_a_id, file_b_id, co_commit_count, strength) VALUES (?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'a.js', 'javascript', '', ''),
      fB = insertFile.run(rid, 'b.js', 'javascript', '', '');
    insertCochange.run(rid, Number(fA.lastInsertRowid), Number(fB.lastInsertRowid), 10, 1.0);

    const result = getAffectedGraph(testDb, rid, { file: 'a.js' });
    expect(result.affected_files.some((f) => f.path === 'b.js')).toBe(true);
    const bFile = result.affected_files.find((f) => f.path === 'b.js');
    expect(bFile.signals).toContain('cochange');
  });

  it('should respect minReachability threshold', () => {
    const { db: testDb, repoId: rid } = setupPropagationDb();
    const { getAffectedGraph } = require('../src/code-analysis/propagation-impl'),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertCochange = testDb.prepare(
        'INSERT INTO file_cochange (repo_id, file_a_id, file_b_id, co_commit_count, strength) VALUES (?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'a.js', 'javascript', '', ''),
      fB = insertFile.run(rid, 'b.js', 'javascript', '', '');
    insertCochange.run(rid, Number(fA.lastInsertRowid), Number(fB.lastInsertRowid), 1, 0.1);

    const result = getAffectedGraph(testDb, rid, { file: 'a.js', minReachability: 0.5 });
    expect(result.affected_files.some((f) => f.path === 'b.js')).toBe(false);
  });
});
