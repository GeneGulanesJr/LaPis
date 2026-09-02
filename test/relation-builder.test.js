// Tests for relation-builder: buildExtendsEdges and buildImplementsEdges
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { buildExtendsEdges, buildImplementsEdges } = require('../src/code-analysis/relation-builder'),
  TMP_DB = path.join('/tmp', 'relation-builder-test.db');

let db, repoId;

function setupTestDb(symbols) {
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
  db.exec(`CREATE TABLE code_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, source_symbol_id INTEGER,
    target_symbol_id INTEGER, source_file_id INTEGER, target_file_id INTEGER,
    kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, line_number INTEGER,
    UNIQUE(repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind)
  )`);
  db.exec('CREATE INDEX idx_cr_repo_kind ON code_relations(repo_id, kind)');

  const insertRepo = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)'),
    insertFile = db.prepare(
      'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
    ),
    insertSymbol =
      db.prepare(`INSERT INTO code_symbols (repo_id, file_id, name, kind, signature, file_path, start_line, end_line,
    start_byte, end_byte, language, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    result = insertRepo.run('test-repo', '/tmp/test');
  repoId = Number(result.lastInsertRowid);

  for (const sym of symbols) {
    let fileId = null;
    if (sym.file_path) {
      const fr = insertFile.run(repoId, sym.file_path, sym.language || 'javascript', '', '');
      fileId = Number(fr.lastInsertRowid);
    }
    insertSymbol.run(
      repoId,
      fileId,
      sym.name,
      sym.kind,
      sym.signature || '',
      sym.file_path || '',
      sym.start_line || 1,
      sym.end_line || 10,
      0,
      100,
      sym.language || 'javascript',
      sym.qualified_name || sym.name,
    );
  }

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

describe('buildExtendsEdges', () => {
  it('should extract extends edge from JS/TS class signature', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        { name: 'Animal', kind: 'class', signature: 'class Animal {', file_path: 'animal.js', language: 'javascript' },
        {
          name: 'Dog',
          kind: 'class',
          signature: 'class Dog extends Animal {',
          file_path: 'dog.js',
          language: 'javascript',
        },
      ]),
      result = buildExtendsEdges(testDb, rid);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);

    const rows = testDb.prepare("SELECT * FROM code_relations WHERE kind = 'extends'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('extends');
    expect(rows[0].weight).toBe(1.0);
  });

  it('should extract extends edge from Python class signature', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        { name: 'Base', kind: 'class', signature: 'class Base:', file_path: 'base.py', language: 'python' },
        { name: 'Child', kind: 'class', signature: 'class Child(Base):', file_path: 'child.py', language: 'python' },
      ]),
      result = buildExtendsEdges(testDb, rid);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('should skip Rust and Go classes', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        { name: 'Animal', kind: 'class', signature: '', file_path: 'animal.rs', language: 'rust' },
        { name: 'Dog', kind: 'struct', signature: '', file_path: 'dog.go', language: 'go' },
      ]),
      result = buildExtendsEdges(testDb, rid);
    expect(result.count).toBe(0);
  });

  it('should not create edge when base class not found', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        {
          name: 'Dog',
          kind: 'class',
          signature: 'class Dog extends NonExistent {',
          file_path: 'dog.js',
          language: 'javascript',
        },
      ]),
      result = buildExtendsEdges(testDb, rid);
    expect(result.count).toBe(0);
  });
});

describe('buildImplementsEdges', () => {
  it('should extract implements edge from TS class', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        {
          name: 'Serializable',
          kind: 'interface',
          signature: 'interface Serializable {',
          file_path: 'types.ts',
          language: 'typescript',
        },
        {
          name: 'Model',
          kind: 'class',
          signature: 'class Model implements Serializable {',
          file_path: 'model.ts',
          language: 'typescript',
        },
      ]),
      result = buildImplementsEdges(testDb, rid);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);

    const rows = testDb.prepare("SELECT * FROM code_relations WHERE kind = 'implements'").all();
    expect(rows).toHaveLength(1);
  });

  it('should extract multiple implements edges', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        { name: 'A', kind: 'interface', signature: 'interface A {', file_path: 'a.ts', language: 'typescript' },
        { name: 'B', kind: 'interface', signature: 'interface B {', file_path: 'b.ts', language: 'typescript' },
        { name: 'C', kind: 'class', signature: 'class C implements A, B {', file_path: 'c.ts', language: 'typescript' },
      ]),
      result = buildImplementsEdges(testDb, rid);
    expect(result.count).toBe(2);
  });

  it('should not create implements edges for Python', () => {
    const { db: testDb, repoId: rid } = setupTestDb([
        { name: 'Base', kind: 'class', signature: 'class Child(Base):', file_path: 'child.py', language: 'python' },
      ]),
      result = buildImplementsEdges(testDb, rid);
    expect(result.count).toBe(0);
  });
});

describe('buildReexportEdges', () => {
  function setupReexportDb() {
    if (fs.existsSync(TMP_DB)) {
      fs.unlinkSync(TMP_DB);
    }
    db = new Database(TMP_DB);
    db.exec(`CREATE TABLE code_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, path TEXT)`);
    db.exec(
      `CREATE TABLE code_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, path TEXT, language TEXT, content TEXT, content_hash TEXT)`,
    );
    db.exec(
      `CREATE TABLE code_imports (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, source_file_id INTEGER, target_module TEXT NOT NULL, target_file_id INTEGER, import_type TEXT NOT NULL DEFAULT 'static', line_number INTEGER, UNIQUE(repo_id, source_file_id, target_module))`,
    );
    db.exec(
      `CREATE TABLE code_relations (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, source_symbol_id INTEGER, target_symbol_id INTEGER, source_file_id INTEGER, target_file_id INTEGER, kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, line_number INTEGER, UNIQUE(repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind))`,
    );
    const insertRepo = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)'),
      result = insertRepo.run('test-repo', '/tmp/test');
    repoId = Number(result.lastInsertRowid);
    return { db, repoId };
  }

  it('should create reexport edge from code_imports with import_type re-export', () => {
    const { db: testDb, repoId: rid } = setupReexportDb(),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertImport = testDb.prepare(
        'INSERT INTO code_imports (repo_id, source_file_id, target_module, target_file_id, import_type) VALUES (?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'barrel.js', 'javascript', '', ''),
      fB = insertFile.run(rid, 'impl.js', 'javascript', '', '');
    insertImport.run(rid, Number(fA.lastInsertRowid), './impl', Number(fB.lastInsertRowid), 're-export');
    const { buildReexportEdges } = require('../src/code-analysis/relation-builder'),
      result = buildReexportEdges(testDb, rid);
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
    const rows = testDb.prepare("SELECT * FROM code_relations WHERE kind = 'reexport'").all();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].source_file_id)).toBe(Number(fA.lastInsertRowid));
  });

  it('should skip non-re-export imports', () => {
    const { db: testDb, repoId: rid } = setupReexportDb(),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertImport = testDb.prepare(
        'INSERT INTO code_imports (repo_id, source_file_id, target_module, target_file_id, import_type) VALUES (?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'consumer.js', 'javascript', '', ''),
      fB = insertFile.run(rid, 'lib.js', 'javascript', '', '');
    insertImport.run(rid, Number(fA.lastInsertRowid), './lib', Number(fB.lastInsertRowid), 'static');
    const { buildReexportEdges } = require('../src/code-analysis/relation-builder'),
      result = buildReexportEdges(testDb, rid);
    expect(result.count).toBe(0);
  });
});

describe('buildReferenceEdges', () => {
  function setupReferenceDb() {
    if (fs.existsSync(TMP_DB)) {
      fs.unlinkSync(TMP_DB);
    }
    db = new Database(TMP_DB);
    db.exec(`CREATE TABLE code_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, path TEXT)`);
    db.exec(
      `CREATE TABLE code_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, path TEXT, language TEXT, content TEXT, content_hash TEXT)`,
    );
    db.exec(
      `CREATE TABLE code_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, file_id INTEGER, name TEXT, kind TEXT, signature TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER, start_byte INTEGER, end_byte INTEGER, docstring TEXT DEFAULT '', body_preview TEXT DEFAULT '', language TEXT NOT NULL, parent_name TEXT DEFAULT '', qualified_name TEXT NOT NULL, stable_symbol_id TEXT DEFAULT '', content_hash TEXT DEFAULT '', summary TEXT DEFAULT '', decorators_json TEXT DEFAULT '[]', keywords_json TEXT DEFAULT '[]', call_references_json TEXT DEFAULT '[]', ecosystem_context TEXT DEFAULT '', indexed_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    db.exec(
      `CREATE TABLE file_scope_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, file_id INTEGER, name TEXT, kind TEXT, origin TEXT, source_file_id INTEGER, source_name TEXT, line_start INTEGER, line_end INTEGER, scope_depth INTEGER DEFAULT 0, byte_start INTEGER, byte_end INTEGER, first_seen_pass INTEGER DEFAULT 0)`,
    );
    db.exec(
      `CREATE TABLE scope_resolution (binding_id INTEGER PRIMARY KEY, resolved_symbol_id INTEGER, resolved_file_id INTEGER, status TEXT NOT NULL, resolved_at_pass INTEGER, confidence REAL DEFAULT 1.0)`,
    );
    db.exec(
      `CREATE TABLE code_relations (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, source_symbol_id INTEGER, target_symbol_id INTEGER, source_file_id INTEGER, target_file_id INTEGER, kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, line_number INTEGER, UNIQUE(repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind))`,
    );
    const insertRepo = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)'),
      result = insertRepo.run('test-repo', '/tmp/test');
    repoId = Number(result.lastInsertRowid);
    return { db, repoId };
  }

  it('should create reference edge for non-function resolved bindings', () => {
    const { db: testDb, repoId: rid } = setupReferenceDb(),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertSymbol = testDb.prepare(
        `INSERT INTO code_symbols (repo_id, file_id, name, kind, signature, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertBinding = testDb.prepare(
        'INSERT INTO file_scope_bindings (repo_id, file_id, name, kind, origin, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      insertResolution = testDb.prepare(
        'INSERT INTO scope_resolution (binding_id, resolved_symbol_id, resolved_file_id, status, resolved_at_pass, confidence) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'consumer.ts', 'typescript', '', ''),
      fB = insertFile.run(rid, 'types.ts', 'typescript', '', ''),
      typeSym = insertSymbol.run(
        rid,
        Number(fB.lastInsertRowid),
        'MyType',
        'class',
        'class MyType',
        'types.ts',
        1,
        5,
        0,
        100,
        'typescript',
        'MyType',
      );
    insertSymbol.run(
      rid,
      Number(fA.lastInsertRowid),
      'process',
      'function',
      'function process()',
      'consumer.ts',
      1,
      10,
      0,
      200,
      'typescript',
      'process',
    );
    const binding = insertBinding.run(rid, Number(fA.lastInsertRowid), 'MyType', 'class', 'import', 1, 1);
    insertResolution.run(
      Number(binding.lastInsertRowid),
      Number(typeSym.lastInsertRowid),
      Number(fB.lastInsertRowid),
      'resolved',
      2,
      1.0,
    );
    const { buildReferenceEdges } = require('../src/code-analysis/relation-builder'),
      result = buildReferenceEdges(testDb, rid);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    const rows = testDb.prepare("SELECT * FROM code_relations WHERE kind = 'references'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(0.8);
  });

  it('should not create reference edge for function/method bindings', () => {
    const { db: testDb, repoId: rid } = setupReferenceDb(),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertSymbol = testDb.prepare(
        `INSERT INTO code_symbols (repo_id, file_id, name, kind, signature, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertBinding = testDb.prepare(
        'INSERT INTO file_scope_bindings (repo_id, file_id, name, kind, origin, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      insertResolution = testDb.prepare(
        'INSERT INTO scope_resolution (binding_id, resolved_symbol_id, resolved_file_id, status, resolved_at_pass, confidence) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'caller.ts', 'typescript', '', ''),
      fB = insertFile.run(rid, 'lib.ts', 'typescript', '', ''),
      fnSym = insertSymbol.run(
        rid,
        Number(fB.lastInsertRowid),
        'helper',
        'function',
        'function helper()',
        'lib.ts',
        1,
        5,
        0,
        100,
        'typescript',
        'helper',
      ),
      binding = insertBinding.run(rid, Number(fA.lastInsertRowid), 'helper', 'function', 'import', 1, 1);
    insertResolution.run(
      Number(binding.lastInsertRowid),
      Number(fnSym.lastInsertRowid),
      Number(fB.lastInsertRowid),
      'resolved',
      2,
      1.0,
    );
    const { buildReferenceEdges } = require('../src/code-analysis/relation-builder'),
      result = buildReferenceEdges(testDb, rid);
    expect(result.count).toBe(0);
  });
});
