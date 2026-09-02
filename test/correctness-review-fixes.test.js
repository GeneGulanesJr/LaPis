const dreamService = require('../services/dream'),
  sessionCmd = require('../commands/session'),
  { mapSearchRows } = require('../src/http/handlers/memory'),
  { search } = require('../src/memory-domain/search'),
  { createAurexRepository } = require('../src/platform/storage/repositories/aurex'),
  { logNegativeRecall } = require('../commands/observation'),
  dbModule = require('../db');

describe('correctness review fixes', () => {
  beforeAll(() => {
    dbModule.ensureDb();
  });

  it('dream service exports runCompactCheap and runVacuum for session-end wiring', () => {
    expect(typeof dreamService.runCompactCheap).toBe('function');
    expect(typeof dreamService.runVacuum).toBe('function');
  });

  it('session-end command wires compaction helpers from dream service', () => {
    const { sqlJson, sqlRun, ensureDb } = dbModule;
    ensureDb();
    sqlRun("INSERT INTO session_log (project, started_at) VALUES ('correctness-fix', datetime('now'))");
    const id = sqlJson('SELECT id FROM session_log ORDER BY id DESC LIMIT 1')[0].id,
      result = sessionCmd.sessionEnd({ sqlJson, sqlRun }, { id: String(id), memories: '0' });
    expect(result.compacted).toBeDefined();
    expect(result.compacted.ok).toBe(true);
  });

  it('mapSearchRows maps memory search results for HTTP handlers', () => {
    const rows = mapSearchRows([
      { id: 1, title: 'T', snippet: 'body', type: 'decision', scope: 'project', topic_key: 'k' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('body');
    expect(rows[0].topicKey).toBe('k');
  });

  it('memory search returns results object consumed by HTTP layer', () => {
    const deps = {
        sqlJson: dbModule.sqlJson,
        sqlRun: dbModule.sqlRun,
        jsonErrNoExit: (msg) => ({ error: msg }),
      },
      result = (() => {
        dbModule.sqlRun(
          "INSERT INTO observations (session_id, type, title, content, project, scope) VALUES ('1','decision','HTTP fix token','unique-http-fix-token','p','project')",
        );

        return search(deps, { query: 'unique-http-fix-token', limit: '5' });
      })();
    expect(result.results?.length).toBeGreaterThan(0);
    expect(mapSearchRows(result.results)).toHaveLength(result.results.length);
  });

  it('listMissionLedgers includes todos for each ledger', () => {
    const repo = createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }),
      missionA = `mission-list-a-${Date.now()}`,
      missionB = `mission-list-b-${Date.now()}`,
      list = (() => {
        repo.createMissionLedger({ missionId: missionA, missionTitle: 'List A', status: 'planning' });
        repo.createMissionLedger({ missionId: missionB, missionTitle: 'List B', status: 'planning' });
        repo.createTodo(missionA, { title: 'Todo A', status: 'ready', goal: 'g' });
        repo.createTodo(missionB, { title: 'Todo B', status: 'ready', goal: 'g' });

        return repo.listMissionLedgers();
      })();
    expect(list.find((l) => l.missionId === missionA)?.todos?.length).toBe(1);
    expect(list.find((l) => l.missionId === missionB)?.todos?.length).toBe(1);
  });

  it('listMissionLedgers loads todos in a single batch query', () => {
    const repo = createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }),
      missionA = `mission-batch-a-${Date.now()}`,
      missionB = `mission-batch-b-${Date.now()}`;
    repo.createMissionLedger({ missionId: missionA, missionTitle: 'Batch A', status: 'planning' });
    repo.createMissionLedger({ missionId: missionB, missionTitle: 'Batch B', status: 'planning' });
    repo.createTodo(missionA, { title: 'Batch todo A', status: 'ready', goal: 'g' });
    repo.createTodo(missionB, { title: 'Batch todo B', status: 'ready', goal: 'g' });

    {
      const originalSqlJson = dbModule.sqlJson,
        todoQueries = [],
        sqlJsonSpy = (query, params) => {
          if (typeof query === 'string' && query.includes('FROM todo_items WHERE mission_id IN')) {
            todoQueries.push(query);
          }
          return originalSqlJson(query, params);
        },
        spiedRepo = createAurexRepository({ sqlJson: sqlJsonSpy, sqlRun: dbModule.sqlRun });
      spiedRepo.listMissionLedgers();
      expect(todoQueries).toHaveLength(1);
    }
  });

  it('claimNextReadyTodo skips todos with incomplete dependencies', () => {
    const repo = createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }),
      missionId = `mission-claim-${Date.now()}`,
      blockerId = `blocker-${Date.now()}`,
      blockedId = `blocked-${Date.now()}`,
      blocker = (() => {
        repo.createMissionLedger({ missionId, missionTitle: 'Claim test', status: 'planning' });

        return repo.createTodo(missionId, { id: blockerId, title: 'Blocker', status: 'ready', goal: 'g' })[0];
      })();
    repo.createTodo(missionId, {
      id: blockedId,
      title: 'Blocked',
      status: 'ready',
      goal: 'g',
      dependsOn: [blocker.id],
    });
    const claimed = repo.claimNextReadyTodo(missionId, 'worker-a'),
      blockedClaim = (() => {
        expect(claimed[0]?.id).toBe(blocker.id);

        return repo.claimNextReadyTodo(missionId, 'worker-b');
      })();
    expect(blockedClaim).toEqual([]);
  });

  it('claimNextReadyTodo allows claim when dependency is implemented', () => {
    const repo = createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }),
      missionId = `mission-claim-impl-${Date.now()}`,
      blockerId = `blocker-impl-${Date.now()}`,
      blockedId = `blocked-impl-${Date.now()}`,
      claimed = (() => {
        repo.createMissionLedger({ missionId, missionTitle: 'Implemented dep', status: 'planning' });
        repo.createTodo(missionId, { id: blockerId, title: 'Blocker', status: 'ready', goal: 'g' });
        repo.createTodo(missionId, {
          id: blockedId,
          title: 'Blocked',
          status: 'ready',
          goal: 'g',
          dependsOn: [blockerId],
        });
        repo.claimNextReadyTodo(missionId, 'worker-a');
        repo.addTodoEvidence(blockerId, { changedFiles: ['src/a.js'] });
        repo.setTodoStatus(blockerId, 'implemented');

        return repo.claimNextReadyTodo(missionId, 'worker-b');
      })();
    expect(claimed[0]?.id).toBe(blockedId);
  });

  it('logNegativeRecall returns structured error for invalid JSON', () => {
    const result = logNegativeRecall({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }, { entries: '{not-json' });
    expect(result.error).toBe('Invalid --entries JSON');
  });

  it('file_scope_bindings has source_module column after migration', () => {
    const cols = dbModule.sqlJson('PRAGMA table_info(file_scope_bindings)');
    expect(cols.some((c) => c.name === 'source_module')).toBe(true);
  });

  it('resolveScopeBindings runs without missing-column SQL errors', () => {
    const db = dbModule.getDb(),
      repoPath = `/tmp/scope-fix-${Date.now()}`,
      repoId = (() => {
        db.prepare('INSERT INTO code_repos (name, path, head_commit) VALUES (?, ?, NULL)').run('scope-fix', repoPath);

        return db.prepare('SELECT id FROM code_repos WHERE name = ?').get('scope-fix').id;
      })(),
      fileId = (() => {
        db.prepare(
          'INSERT INTO code_files (repo_id, path, content_hash, language, content) VALUES (?, ?, ?, ?, ?)',
        ).run(repoId, `${repoPath}/a.js`, 'abc', 'javascript', 'export const x = 1;');

        return db.prepare('SELECT id FROM code_files WHERE repo_id = ?').get(repoId).id;
      })();
    db.prepare(
      `INSERT INTO file_scope_bindings (repo_id, file_id, name, kind, origin, source_file_id, source_name, source_module, line_start, line_end, scope_depth)
       VALUES (?, ?, 'foo', 'named_import', 'external_file', NULL, 'foo', './utils', 1, 1, 0)`,
    ).run(repoId, fileId);
    {
      const { resolveScopeBindings } = require('../src/code-index/scope-resolver');
      expect(() => resolveScopeBindings(db, repoId)).not.toThrow();
      db.prepare('DELETE FROM code_repos WHERE name = ?').run('scope-fix');
    }
  });
});
