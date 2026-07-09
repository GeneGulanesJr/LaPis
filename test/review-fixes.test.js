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

    it('advances user_version from 22 to 23 and creates repo_index_locks', () => {
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
      expect(version).toBe(23);
      expect(table).toBeTruthy();
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
  });

  describe('pr-risk git ref validation', () => {
    it('rejects shell metacharacters in branch/base without executing', () => {
      const db = dbModule.getDb();
      const repo = db.prepare('SELECT id FROM code_repos LIMIT 1').get();
      if (!repo) {
        return;
      }
      const result = getPrRiskProfile(db, repo.id, {
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
