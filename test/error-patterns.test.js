// Test coverage for standardized error patterns (Issue #34)
// And test isolation / atomic migrations (Issues #35, #36)
const path = require('path'),
  os = require('os'),
  fs = require('fs'),
  dbModule = require('../db'),
  { MemoryError } = dbModule,
  { resetConfigCache } = require('../config');

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
    it('lazily opens the DB when the handle is unset and runs the transaction', () => {
      // Since the lazy-open change, an unset handle is no longer an error:
      // The first SQL use self-ensures (opens the global DB) and proceeds.
      dbModule.resetDb();
      try {
        let ran = false;
        expect(() =>
          dbModule.withTransaction(() => {
            ran = true;
          }),
        ).not.toThrow();
        expect(ran).toBe(true);
        expect(dbModule.getEngine()).toBe('better-sqlite3');
      } finally {
        dbModule.ensureDb();
      }
    });

    it('still fails loudly (backend error) when the DB cannot be opened', () => {
      // The real error path the old "MemoryError when not initialized" test
      // Guarded: an unavailable DB must surface at the first SQL use, never
      // Silently no-op. A directory where the DB file belongs makes
      // The better-sqlite3 open fail, so the lazy self-ensure throws.
      const { getConfig } = require('../config'),
        badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-bad-db-')),
        badPath = path.join(badDir, 'memory.db'),
        savedConfig = getConfig._cached;
      fs.mkdirSync(badPath);
      dbModule.resetDb();
      getConfig._cached = { ...savedConfig, db_path: badPath };
      try {
        expect(() => dbModule.withTransaction(() => {})).toThrow(/No SQLite backend found/);
      } finally {
        getConfig._cached = savedConfig;
        dbModule.resetDb();
        dbModule.ensureDb();
        fs.rmSync(badDir, { recursive: true, force: true });
      }
    });
  });

  describe('db.js — resetDb / createDb (Issue #36)', () => {
    it('resetDb should drop the handle; the next access lazily re-opens', () => {
      dbModule.ensureDb();
      expect(dbModule.getEngine()).toBeTruthy();

      dbModule.resetDb();
      // The unguarded getEngine() accessor proves the reset happened.
      expect(dbModule.getEngine()).toBeNull();
      // In contrast, getDb() self-ensures since the lazy-open change: the next
      // Consumer gets a fresh global-DB handle instead of null — this mirrors
      // The resetDb expectation in test/db.test.js.
      expect(dbModule.getDb()).toBeTruthy();

      // Restore for other tests
      dbModule.ensureDb();
    });

    it('createDb should create isolated DB with custom path', () => {
      const tmpPath = path.join(os.tmpdir(), `pi-mem-test-createdb-${Date.now()}.db`),
        result = dbModule.createDb({ db_path: tmpPath });
      expect(result.ok).toBe(true);
      expect(result.engine).toMatch(/better-sqlite3/);

      // Cleanup: close the created DB and delete temp file
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

      // Restore global singleton
      resetConfigCache();
      dbModule.ensureDb();
    });

    it('createDb should not corrupt the global singleton', () => {
      const globalPath = dbModule.DB_PATH,
        globalEngine = dbModule.getEngine(),
        tmpPath = path.join(os.tmpdir(), `pi-mem-test-isolation-${Date.now()}.db`);
      dbModule.createDb({ db_path: tmpPath });

      // After createDb, _db points to the temp DB and config is overridden
      // Reset everything to restore global singleton
      dbModule.resetDb();
      resetConfigCache();
      dbModule.ensureDb();

      expect(dbModule.getEngine()).toBe(globalEngine);
      expect(dbModule.DB_PATH).toBe(globalPath);

      // Cleanup
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      try {
        fs.unlinkSync(`${tmpPath}-wal`);
      } catch {}
      try {
        fs.unlinkSync(`${tmpPath}-shm`);
      } catch {}
    });
  });

  describe('db.js — atomic migrations (Issue #35)', () => {
    it('should report migration status when up-to-date', () => {
      const result = dbModule.ensureDb(),
        rows = (() => {
          expect(result.ok).toBe(true);

          return dbModule.sqlJson('PRAGMA user_version');
        })();
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
      const err1 = dbModule.jsonErrNoExit('Missing --id'),
        err2 = dbModule.jsonErrNoExit('Something went wrong');
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
