const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  db = require('../db'),
  { insertObservation, insertObservationRelation } = require('../data-access/observations'),
  { search } = require('../src/memory-domain/search');

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

  it('degrades to OR-tier when no memory satisfies the full AND conjunction', () => {
    insertObservation(deps, {
      sessionId: '1',
      type: 'decision',
      title: 'Kubernetes clustering choice',
      content: 'Chose kubernetes for orchestration',
      project: 'test',
      scope: 'project',
      topicKey: null,
    });
    insertObservation(deps, {
      sessionId: '1',
      type: 'architecture',
      title: 'Postgres indexing plan',
      content: 'Partial indexes on hot paths',
      project: 'test',
      scope: 'project',
      topicKey: null,
    });
    // No single memory contains all three terms — the AND tier must find
    // nothing, and the OR tier must still recall both, flagged as degraded.
    const result = search(deps, { query: 'kubernetes postgres unicycle', project: 'test' });
    expect(result.degraded).toBe('or');
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });

  it('AND tier stays precise when a memory satisfies the full conjunction', () => {
    insertObservation(deps, {
      sessionId: '1',
      type: 'decision',
      title: 'Redis cache eviction policy',
      content: 'LFU eviction for the Redis cache layer',
      project: 'test',
      scope: 'project',
      topicKey: null,
    });
    const result = search(deps, { query: 'redis cache eviction', project: 'test' });
    expect(result.degraded).toBeNull();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('project scoping matches case-insensitively (historical case-variant buckets)', () => {
    insertObservation(deps, {
      sessionId: '1',
      type: 'decision',
      title: 'Mixed-case project memory',
      content: 'Stored under MixedCase project',
      project: 'MixedCase',
      scope: 'project',
      topicKey: null,
    });
    const result = search(deps, { query: 'MixedCase project memory', project: 'mixedcase' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});
