const fs = require('fs');
const os = require('os');
const path = require('path');

const dbModule = require('../db');
const { getRecalledMemoryIds } = require('../data-access/symbols');
const { trustRecovery } = require('../services/dream');
const { getPrRiskProfile } = require('../src/code-analysis/risk-impl');
const { createHttpServer } = require('../src/http/server');

describe('review fixes', () => {
  describe('migration V23', () => {
    let tmpDb;

    afterEach(() => {
      if (tmpDb && fs.existsSync(tmpDb)) {
        fs.unlinkSync(tmpDb);
      }
      dbModule.resetDb();
      dbModule.ensureDb();
    });

    it('advances user_version from 22 through all pending migrations', () => {
      tmpDb = path.join(os.tmpdir(), `lapis-v23-${Date.now()}.db`);
      dbModule.resetDb();
      dbModule.createDb({ db_path: tmpDb });

      const db = dbModule.getDb();
      db.exec('PRAGMA user_version = 22');
      db.exec('DROP TABLE IF EXISTS repo_index_locks');

      dbModule.resetDb();
      dbModule.createDb({ db_path: tmpDb });

      const reopened = dbModule.getDb();
      const version = reopened.prepare('PRAGMA user_version').get().user_version;
      const table = reopened
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repo_index_locks'")
        .get();
      const sourceModuleCol = reopened
        .prepare('PRAGMA table_info(file_scope_bindings)')
        .all()
        .some((c) => c.name === 'source_module');
      const churnCols = reopened.prepare('PRAGMA table_info(churn_metrics)').all();
      const hasTotalFilesChanged = churnCols.some((c) => c.name === 'total_files_changed');
      const hasTopFilesJson = churnCols.some((c) => c.name === 'top_files_json');
      expect(version).toBe(25);
      expect(table).toBeTruthy();
      expect(sourceModuleCol).toBe(true);
      expect(hasTotalFilesChanged).toBe(true);
      expect(hasTopFilesJson).toBe(true);
    });
  });

  describe('trust recovery from recall_log', () => {
    let sessionId;
    let memoryId;

    beforeAll(() => {
      dbModule.ensureDb();
      const session = dbModule.sqlJson(
        "INSERT INTO session_log (project, started_at) VALUES (?, datetime('now')) RETURNING id",
        ['review-fixes-trust'],
      );
      sessionId = session[0].id;
      const obs = dbModule.sqlJson(
        `INSERT INTO observations (session_id, type, title, content, project, scope)
         VALUES (?, 'decision', 'Trust test', 'content', 'review-fixes-trust', 'project')
         RETURNING id`,
        [sessionId],
      );
      memoryId = obs[0].id;
      dbModule.sqlRun(
        'INSERT INTO recall_log (memory_id, session_id, query, was_useful) VALUES (?, ?, ?, 1)',
        [memoryId, sessionId, 'test-query'],
      );
      dbModule.sqlRun(
        'INSERT INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)',
        [String(memoryId), '__unlinked__', 'review-fixes-trust', 0.5],
      );
    });

    it('getRecalledMemoryIds includes recall_log entries', () => {
      const rows = getRecalledMemoryIds(
        { sqlJson: dbModule.sqlJson },
        sessionId,
      );
      expect(rows.some((r) => String(r.memory_id) === String(memoryId))).toBe(true);
    });

    it('trustRecovery boosts trust for recalled memories', () => {
      const result = trustRecovery({ session: String(sessionId) });
      expect(result.ok).toBe(true);
      expect(result.memoriesRecovered).toBeGreaterThan(0);
    });

    it('trustRecovery ignores memories only recalled with was_useful = 0', () => {
      const session = dbModule.sqlJson(
        "INSERT INTO session_log (project, started_at) VALUES (?, datetime('now')) RETURNING id",
        ['review-fixes-trust-negative'],
      );
      const negativeSessionId = session[0].id;
      const obs = dbModule.sqlJson(
        `INSERT INTO observations (session_id, type, title, content, project, scope)
         VALUES (?, 'decision', 'Ignored recall', 'content', 'review-fixes-trust-negative', 'project')
         RETURNING id`,
        [negativeSessionId],
      );
      const ignoredMemoryId = obs[0].id;
      dbModule.sqlRun(
        'INSERT INTO recall_log (memory_id, session_id, query, was_useful) VALUES (?, ?, ?, 0)',
        [ignoredMemoryId, negativeSessionId, 'ignored-search'],
      );
      dbModule.sqlRun(
        'INSERT INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)',
        [String(ignoredMemoryId), '__unlinked__', 'review-fixes-trust-negative', 0.5],
      );

      const recalled = getRecalledMemoryIds({ sqlJson: dbModule.sqlJson }, negativeSessionId);
      expect(recalled.some((r) => String(r.memory_id) === String(ignoredMemoryId))).toBe(false);

      const result = trustRecovery({ session: String(negativeSessionId) });
      expect(result.ok).toBe(true);
      expect(result.memoriesRecovered).toBe(0);
    });
  });

  describe('pr-risk git ref validation', () => {
    let repoId;

    beforeAll(() => {
      dbModule.ensureDb();
      const existing = dbModule.sqlJson('SELECT id FROM code_repos WHERE name = ?', ['review-fixes-pr-risk']);
      if (existing.length > 0) {
        repoId = existing[0].id;
        return;
      }
      const inserted = dbModule.sqlJson(
        'INSERT INTO code_repos (name, path) VALUES (?, ?) RETURNING id',
        ['review-fixes-pr-risk', process.cwd()],
      );
      repoId = inserted[0].id;
    });

    it('rejects shell metacharacters in branch/base without executing', () => {
      const db = dbModule.getDb();
      const result = getPrRiskProfile(db, repoId, {
        branch: 'HEAD; echo pwned',
        base: 'main',
      });
      expect(result.note).toBe('No changed files detected.');
    });
  });

  describe('HTTP body size limit', () => {
    let server;
    let baseUrl;

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('returns 413 when request body exceeds 1MB', async () => {
      const { createAurexRepository } = require('../src/platform/storage/repositories/aurex');
      server = createHttpServer({
        apiKey: null,
        repositories: {
          aurex: createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }),
        },
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;

      const oversized = 'x'.repeat(1024 * 1024 + 1);
      const res = await fetch(`${baseUrl}/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: oversized }),
      });
      expect(res.status).toBe(413);
    });
  });
});
