// Audit 4: concurrent writers must not hit "database is locked" from a stale
// WAL snapshot, and busy retries must not multiply the busy_timeout stall.
// Two real connections share one temp DB: A = db.js, B = raw better-sqlite3.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  Database = require('better-sqlite3'),
  db = require('../db');

describe('db.js busy handling with a second connection', () => {
  let dir, other, warn;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-busy-'));
    db.createDb({ db_path: path.join(dir, 'memory.db'), busy_timeout_ms: 200 });
    db.sqlRaw('CREATE TABLE IF NOT EXISTS busy_t (k TEXT PRIMARY KEY, v TEXT)');
    other = new Database(path.join(dir, 'memory.db'));
    other.pragma('journal_mode = WAL');
    other.pragma('busy_timeout = 50');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    other.close();
    db.resetDb();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  const busyWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('SQLITE_BUSY')).length;

  it('withTransaction read-then-write holds the write lock, so a concurrent writer cannot invalidate it', () => {
    let otherError = null;
    db.withTransaction(() => {
      db.sqlJson('SELECT v FROM busy_t WHERE k = ?', ['a']);
      try {
        other.prepare("INSERT INTO busy_t (k, v) VALUES ('b', 'other')").run();
      } catch (e) {
        otherError = e;
      }
      db.sqlRun("INSERT INTO busy_t (k, v) VALUES ('a', 'mine')");
    });
    // The other writer waited for (and timed out on) our lock instead of
    // Committing under our snapshot and making our write fail.
    expect(otherError && otherError.code).toMatch(/^SQLITE_BUSY/);
    expect(db.sqlJson('SELECT k FROM busy_t ORDER BY k')).toEqual([{ k: 'a' }]);
    other.prepare("INSERT INTO busy_t (k, v) VALUES ('b', 'other')").run();
    expect(db.sqlJson('SELECT k FROM busy_t ORDER BY k')).toEqual([{ k: 'a' }, { k: 'b' }]);
  });

  it('nested withTransaction still works (SAVEPOINT) and rolls back only the inner part', () => {
    db.withTransaction(() => {
      db.sqlRun("INSERT INTO busy_t (k, v) VALUES ('outer', '1')");
      expect(() =>
        db.withTransaction(() => {
          db.sqlRun("INSERT INTO busy_t (k, v) VALUES ('inner', '1')");
          throw new Error('inner fails');
        }),
      ).toThrow('inner fails');
    });
    expect(db.sqlJson('SELECT k FROM busy_t')).toEqual([{ k: 'outer' }]);
  });

  it('does not retry a busy statement inside a transaction (stale snapshot can never succeed)', () => {
    db.sqlRaw('BEGIN'); // deferred, as before the fix
    try {
      db.sqlJson('SELECT v FROM busy_t');
      other.prepare("INSERT INTO busy_t (k, v) VALUES ('b', 'other')").run();
      const t0 = Date.now();
      expect(() => db.sqlRun("INSERT INTO busy_t (k, v) VALUES ('a', 'mine')")).toThrow(/database is locked/);
      expect(busyWarnings()).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      db.sqlRaw('ROLLBACK');
    }
  });

  it('stops retrying once busy_timeout has been spent, bounding the total wait', () => {
    other.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      expect(() => db.sqlRun("INSERT INTO busy_t (k, v) VALUES ('a', 'mine')")).toThrow(/database is locked/);
      expect(busyWarnings()).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      other.exec('ROLLBACK');
    }
  });
});
