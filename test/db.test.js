// Test coverage for db.js database layer
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbModule = require('../db');

describe('db.js (database layer)', () => {
  beforeAll(() => {
    dbModule.ensureDb();
  });

  describe('exports and paths', () => {
    it('should have DB_PATH accessible', () => {
      expect(dbModule.DB_PATH).toBeTruthy();
      expect(dbModule.DB_PATH).toContain('.pi');
      expect(dbModule.DB_PATH).toContain('memory.db');
    });

    it('should have SCHEMA_PATH pointing to a real file', () => {
      expect(fs.existsSync(dbModule.SCHEMA_PATH)).toBe(true);
    });

    it('HOME should be a real directory', () => {
      expect(fs.existsSync(dbModule.HOME)).toBe(true);
    });

    it('should create memory.db in the correct path', () => {
      const dbPath = dbModule.DB_PATH;
      expect(fs.existsSync(dbPath)).toBe(true);
      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);
    });
  });

  describe('ensureDb and getDb', () => {
    it('ensureDb() should return ok: true', () => {
      const result = dbModule.ensureDb();
      expect(result.ok).toBe(true);
      expect(result.db).toBeTruthy();
      expect(['better-sqlite3']).toContain(result.engine);
    });

    it('ensureDb() should be idempotent', () => {
      const r1 = dbModule.ensureDb(),
        r2 = dbModule.ensureDb();
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1.db).toBe(r2.db);
    });

    it('getDb() should return a non-null handle after ensureDb', () => {
      const db = dbModule.getDb();
      expect(db).toBeTruthy();
    });

    it('getEngine() should return a known engine', () => {
      const engine = dbModule.getEngine();
      expect(['better-sqlite3']).toContain(engine);
    });

    it('runMigrations should not throw on version 5 schema', () => {
      const db = dbModule.getDb();
      // Force version to 5
      db.exec('PRAGMA user_version = 5');
      const result = dbModule.ensureDb();
      expect(result.ok).toBe(true);
    });
  });

  describe('sqlJson', () => {
    it('should query and return results', () => {
      const rows = dbModule.sqlJson('SELECT 1 as val');
      expect(rows.length).toBe(1);
      expect(rows[0].val).toBe(1);
    });

    it('with parameters should use placeholders', () => {
      const rows = dbModule.sqlJson('SELECT ? as a, ? as b', [42, 'test']);
      expect(rows[0].a).toBe(42);
      expect(rows[0].b).toBe('test');
    });

    it('should throw on invalid SQL', () => {
      expect(() => dbModule.sqlJson('SELECT * FROM nonexistent_table_xyz_123')).toThrow();
    });
  });

  describe('sqlRun and sqlRaw', () => {
    it('sqlRun() should execute DML without error', () => {
      dbModule.sqlRun('CREATE TABLE IF NOT EXISTS _db_test (id INTEGER PRIMARY KEY, val TEXT)');
      dbModule.sqlRun('INSERT OR REPLACE INTO _db_test (id, val) VALUES (?, ?)', [1, 'hello']);
      const rows = dbModule.sqlJson('SELECT val FROM _db_test WHERE id = 1');
      expect(rows[0].val).toBe('hello');
      dbModule.sqlRun('DELETE FROM _db_test WHERE id = 1');
    });

    it('sqlRaw() should execute raw SQL', () => {
      dbModule.sqlRaw('DROP TABLE IF EXISTS _db_test');
      expect(() => dbModule.sqlJson('SELECT 1 FROM _db_test')).toThrow();
    });

    it('sqlRun() should throw on invalid SQL', () => {
      expect(() => dbModule.sqlRun('INSERT INTO nonexistent_table VALUES (1)')).toThrow();
    });
  });

  describe('withTransaction', () => {
    it('should commit on success', () => {
      dbModule.ensureDb();
      const result = dbModule.withTransaction(() => {
        dbModule.sqlRun('CREATE TABLE IF NOT EXISTS _txn_test (id INTEGER PRIMARY KEY, val REAL)');
        return { done: true };
      });
      expect(result.done).toBe(true);
      dbModule.sqlRun('DROP TABLE IF EXISTS _txn_test');
    });

    it('should rollback on error', () => {
      dbModule.ensureDb();
      expect(() => {
        dbModule.withTransaction(() => {
          dbModule.sqlRun('CREATE TABLE IF NOT EXISTS _txn_test2 (id INTEGER PRIMARY KEY)');
          throw new Error('forced error');
        });
      }).toThrow('forced error');
      // Table should not exist after rollback
      expect(() => dbModule.sqlJson('SELECT 1 FROM _txn_test2')).toThrow();
    });
  });

  describe('resetDb and createDb', () => {
    it('resetDb should null out the db handle', () => {
      const db = dbModule.getDb();
      expect(db).toBeTruthy(); // Ensure db is initialized
      dbModule.resetDb();
      expect(dbModule.getDb()).toBeNull();
      dbModule.ensureDb(); // Restore for subsequent tests
    });

    it('createDb should open a database at custom path', () => {
      const tmpPath = path.join(os.tmpdir(), `pi-mem-test-${Date.now()}.db`),
        result = dbModule.createDb({ db_path: tmpPath });
      expect(result.ok).toBe(true);
      // Cleanup
      dbModule.resetDb();
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      try {
        fs.unlinkSync(`${tmpPath}-wal`);
      } catch {}
      try {
        fs.unlinkSync(`${tmpPath}-shm`);
      } catch {}
      const { resetConfigCache } = require('../config');
      resetConfigCache();
      dbModule.ensureDb();
    });
  });

  describe('MemoryError', () => {
    it('should be an Error subclass with context', () => {
      const err = new dbModule.MemoryError('test', { code: 'TEST' });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('MemoryError');
      expect(err.context).toEqual({ code: 'TEST' });
    });

    it('jsonErr should throw MemoryError', () => {
      expect(() => dbModule.jsonErr('fatal')).toThrow(dbModule.MemoryError);
    });
  });

  describe('utilities', () => {
    it('jsonOut() should not throw on valid object', () => {
      // JsonOut writes to stdout — just verify it doesn't throw
      expect(() => dbModule.jsonOut({ test: 1 })).not.toThrow();
    });

    it('parseArgs() should parse CLI arguments', () => {
      // Simulate node memory-store.js subcommand with repo and path flags
      const args = dbModule.parseArgs([
        'node',
        'memory-store.js',
        'index-repo',
        '--repo',
        'test',
        '--path',
        '/tmp',
        '--force',
      ]);
      expect(args.repo).toBe('test');
      expect(args.path).toBe('/tmp');
      expect(args.force).toBe(true);
    });

    it('parseArgs() should handle --flag style args', () => {
      const args = dbModule.parseArgs(['node', 'memory-store.js', 'search', '--dry-run']);
      expect(args['dry-run']).toBe(true);
    });
  });
});
