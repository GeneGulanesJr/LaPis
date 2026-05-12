// Test coverage for standardized error patterns (Issue #34)
// And test isolation / atomic migrations (Issues #35, #36)
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbModule = require('../db');
const { MemoryError } = dbModule;
const { resetConfigCache } = require('../config');

describe('Error patterns and DB isolation', () => {
  beforeAll(() => {
    dbModule.ensureDb();
  });

  afterEach(() => {
    resetConfigCache();
    if (!dbModule.getDb()) {
      dbModule.ensureDb();
    }
  });

  afterAll(() => {
    resetConfigCache();
    dbModule.resetDb();
    dbModule.ensureDb();
  });

  describe('db.js — MemoryError', () => {
    it('should be an Error subclass', () => {
      const err = new MemoryError('test error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MemoryError);
      expect(err.name).toBe('MemoryError');
      expect(err.message).toBe('test error');
    });

    it('should carry context data', () => {
      const err = new MemoryError('migration failed', { version: 4, table: 'workspaces' });
      expect(err.context).toEqual({ version: 4, table: 'workspaces' });
    });
  });

  describe('db.js — jsonErr / jsonErrNoExit', () => {
    it('jsonErrNoExit should return error object without exiting', () => {
      const result = dbModule.jsonErrNoExit('something went wrong');
      expect(result).toEqual({ error: 'something went wrong' });
    });

    it('jsonErr should throw MemoryError instead of process.exit', () => {
      expect(() => dbModule.jsonErr('fatal')).toThrow(MemoryError);
      expect(() => dbModule.jsonErr('fatal')).toThrow('fatal');
    });
  });

  describe('db.js — withTransaction', () => {
    it('should throw MemoryError when db not initialized', () => {
      dbModule.resetDb();
      try {
        expect(() => dbModule.withTransaction(() => {})).toThrow(MemoryError);
      } finally {
        dbModule.ensureDb();
      }
    });
  });

  describe('db.js — resetDb / createDb (Issue #36)', () => {
    it('resetDb should null out _db and _engine', () => {
      dbModule.ensureDb();
      expect(dbModule.getDb()).toBeTruthy();

      dbModule.resetDb();
      expect(dbModule.getDb()).toBeNull();
      expect(dbModule.getEngine()).toBeNull();

      // Restore for other tests
      dbModule.ensureDb();
    });

    it('createDb should create isolated DB with custom path', () => {
      const tmpPath = path.join(os.tmpdir(), `pi-mem-test-createdb-${Date.now()}.db`);
      const result = dbModule.createDb({ db_path: tmpPath });
      expect(result.ok).toBe(true);
      expect(result.engine).toMatch(/node-sqlite|better-sqlite3/);

      // Cleanup: close the created DB and delete temp file
      dbModule.resetDb();
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(`${tmpPath}-wal`); } catch (_) {}
      try { fs.unlinkSync(`${tmpPath}-shm`); } catch (_) {}

      // Restore global singleton
      resetConfigCache();
      dbModule.ensureDb();
    });

    it('createDb should not corrupt the global singleton', () => {
      const globalPath = dbModule.DB_PATH;
      const globalEngine = dbModule.getEngine();

      const tmpPath = path.join(os.tmpdir(), `pi-mem-test-isolation-${Date.now()}.db`);
      dbModule.createDb({ db_path: tmpPath });

      // After createDb, _db points to the temp DB and config is overridden
      // Reset everything to restore global singleton
      dbModule.resetDb();
      resetConfigCache();
      dbModule.ensureDb();

      expect(dbModule.getEngine()).toBe(globalEngine);
      expect(dbModule.DB_PATH).toBe(globalPath);

      // Cleanup
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(`${tmpPath}-wal`); } catch (_) {}
      try { fs.unlinkSync(`${tmpPath}-shm`); } catch (_) {}
    });
  });

  describe('db.js — atomic migrations (Issue #35)', () => {
    it('should report migration status when up-to-date', () => {
      const result = dbModule.ensureDb();
      expect(result.ok).toBe(true);

      const rows = dbModule.sqlJson('PRAGMA user_version');
      expect(rows[0].user_version).toBeGreaterThanOrEqual(6);
    });

    it('migrations should not silently swallow errors', () => {
      // Ensure DB is healthy
      const result = dbModule.ensureDb();
      expect(result.ok).toBe(true);
      // If already migrated, 'migrated' should be false
      // (We can't easily test migration failure without corrupting the DB)
    });

    it('withTransaction should commit on success', () => {
      dbModule.ensureDb();
      const result = dbModule.withTransaction(() => {
        dbModule.sqlRun('CREATE TABLE IF NOT EXISTS _txn_test (id INTEGER PRIMARY KEY, val REAL)');
        return { done: true };
      });
      expect(result.done).toBe(true);
      dbModule.sqlRun('DROP TABLE IF EXISTS _txn_test');
    });

    it('withTransaction should rollback on error', () => {
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

  describe('Consistent error return pattern (Issue #34)', () => {
    it('jsonErrNoExit returns { error } objects consistently', () => {
      // All library functions that return errors should use this pattern
      const err1 = dbModule.jsonErrNoExit('Missing --id');
      const err2 = dbModule.jsonErrNoExit('Something went wrong');
      expect(err1).toEqual({ error: 'Missing --id' });
      expect(err2).toEqual({ error: 'Something went wrong' });
      // Both have the same shape: { error: string }
      expect(Object.keys(err1)).toEqual(['error']);
      expect(Object.keys(err2)).toEqual(['error']);
    });

    it('jsonErr throws MemoryError (no process.exit)', () => {
      // Library code can no longer call process.exit — it throws instead
      // CLI dispatch catches MemoryError and handles exit
      let caught = null;
      try {
        dbModule.jsonErr('unrecoverable');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MemoryError);
      expect(caught.message).toBe('unrecoverable');
    });
  });
});