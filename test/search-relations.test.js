const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { insertObservation, insertObservationRelation } = require('../data-access/observations');
const { search } = require('../src/memory-domain/search');

describe('search with relations', () => {
  let deps, tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-search-relations-'));
    db.resetDb();
    db.createDb({ db_path: path.join(tempDir, 'memory.db') });
    deps = {
      sqlJson: db.sqlJson,
      sqlRun: db.sqlRun,
      jsonErrNoExit: (msg) => ({ error: msg }),
      searchCode: null,
    };
  });

  afterEach(() => {
    db.resetDb();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('includes _relations field showing superseding memories', () => {
    const obs1 = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'Use React for frontend',
        content: 'React is the choice because of ecosystem',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      obs2 = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'Switched to Vue for frontend',
        content: 'Vue is better for this project because of simplicity',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id1 = obs1[0].id,
      id2 = obs2[0].id;

    insertObservationRelation(deps, { sourceId: id2, targetId: id1, relation: 'supersedes', confidence: 0.9 });

    const result = search(deps, { query: 'frontend', project: 'test', 'session-id': '99' }),
      oldMemory = result.results.find((r) => r.id === id1);
    expect(oldMemory).toBeDefined();
    expect(oldMemory._relations).toBeDefined();
    expect(oldMemory._relations).toHaveLength(1);
    expect(oldMemory._relations[0].relation).toBe('supersedes');
    expect(oldMemory._relations[0].source_id).toBe(id2);
    expect(oldMemory._relations[0].target_id).toBe(id1);
  });

  it('includes _relations showing related memories', () => {
    const obs1 = insertObservation(deps, {
        sessionId: '1',
        type: 'architecture',
        title: 'REST API design',
        content: 'Using REST for the API layer',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      obs2 = insertObservation(deps, {
        sessionId: '1',
        type: 'architecture',
        title: 'GraphQL API design',
        content: 'Using GraphQL alongside REST',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id1 = obs1[0].id,
      id2 = obs2[0].id;

    insertObservationRelation(deps, { sourceId: id1, targetId: id2, relation: 'related', confidence: 0.7 });

    const result = search(deps, { query: 'API', project: 'test', 'session-id': '99' }),
      mem = result.results.find((r) => r.id === id1);
    expect(mem._relations).toBeDefined();
    expect(mem._relations.length).toBeGreaterThanOrEqual(1);
    expect(mem._relations.some((r) => r.relation === 'related')).toBe(true);
  });
});
