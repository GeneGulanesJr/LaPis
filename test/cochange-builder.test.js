// Tests for cochange-builder
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3'),
  TMP_DB = path.join('/tmp', 'cochange-test.db');

let db, repoId;

function setupTestDb() {
  if (fs.existsSync(TMP_DB)) {
    fs.unlinkSync(TMP_DB);
  }
  db = new Database(TMP_DB);

  db.exec(`CREATE TABLE code_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, path TEXT)`);
  db.exec(
    `CREATE TABLE code_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, path TEXT, language TEXT, content TEXT, content_hash TEXT)`,
  );
  db.exec(`CREATE TABLE file_cochange (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER, file_a_id INTEGER, file_b_id INTEGER,
    co_commit_count INTEGER NOT NULL DEFAULT 0, strength REAL NOT NULL DEFAULT 0,
    window_days INTEGER NOT NULL DEFAULT 90,
    UNIQUE(repo_id, file_a_id, file_b_id)
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

describe('parseGitLogForCochange', () => {
  it('should count file pairs from commit groups', () => {
    const { parseGitLogForCochange } = require('../src/code-analysis/cochange-builder'),
      log = `COMMIT:abc123\nsrc/a.js\nsrc/b.js\nsrc/c.js\nCOMMIT:def456\nsrc/a.js\nsrc/b.js\nCOMMIT:ghi789\nsrc/b.js\nsrc/c.js`,
      pairs = parseGitLogForCochange(log);
    expect(pairs['src/a.js::src/b.js']).toBe(2);
    expect(pairs['src/a.js::src/c.js']).toBe(1);
    expect(pairs['src/b.js::src/c.js']).toBe(2);
  });

  it('should skip commits with only 1 file', () => {
    const { parseGitLogForCochange } = require('../src/code-analysis/cochange-builder'),
      log = `COMMIT:abc123\nsrc/a.js\nCOMMIT:def456\nsrc/a.js\nsrc/b.js`,
      pairs = parseGitLogForCochange(log);
    expect(Object.keys(pairs)).toHaveLength(1);
    expect(pairs['src/a.js::src/b.js']).toBe(1);
  });
});

describe('storeCochangePairs', () => {
  it('should store co-change pairs in both directions', () => {
    const { db: testDb, repoId: rid } = setupTestDb(),
      insertFile = testDb.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      fA = insertFile.run(rid, 'src/a.js', 'javascript', '', ''),
      fB = insertFile.run(rid, 'src/b.js', 'javascript', '', '');

    const { storeCochangePairs } = require('../src/code-analysis/cochange-builder'),
      pairs = { 'src/a.js::src/b.js': 5 },
      pathToId = new Map([
        ['src/a.js', Number(fA.lastInsertRowid)],
        ['src/b.js', Number(fB.lastInsertRowid)],
      ]),
    rows = (() => {

  
      storeCochangePairs(testDb, rid, pairs, pathToId, 90);
  
      
  return (testDb.prepare('SELECT * FROM file_cochange').all());
})();expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.co_commit_count === 5)).toBe(true);
    expect(rows.every((r) => r.strength === 1.0)).toBe(true);
  });
});
