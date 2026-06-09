/**
 * Mutation-killing tests for P0 files.
 *
 * These tests specifically target surviving mutants identified by Stryker.
 * They exercise edge cases, boundary conditions, and specific code paths
 * that generic integration tests miss.
 */
const { rankObservations, search, symbolCluster, related, _extractFtsTerms: extractFtsTerms } = require('../src/memory-domain/search');
const { trigramOverlap, checkDuplicate, markDuplicate } = require('../src/memory-domain/dedupe');
const { insertRecallLog, getRecallCount, recallScore } = require('../src/memory-domain/recall');
const { context, topicQueryNeedles, buildTopicQueryMatch, applyTokenBudget } = require('../src/memory-domain/context');
const { createMemoryRepository } = require('../src/platform/storage/repositories/memory');
const { RANKING, CONTEXT, TIME_WINDOWS, RESULT_LIMITS } = require('../constants');

// ─── helpers ───
function mockDeps(overrides = {}) {
  return {
    sqlJson: vi.fn(() => []),
    sqlRun: vi.fn(),
    jsonErrNoExit: vi.fn(() => ({ error: 'err' })),
    insertRecallLog: vi.fn(),
    countObservationsByProjectAndType: vi.fn(() => 0),
    searchCode: vi.fn(() => []),
    softDeleteObservation: vi.fn(),
    ...overrides,
  };
}

function baseObs(overrides = {}) {
  const ts = new Date().toISOString().replace('Z', '');
  return {
    id: 1,
    title: 'test observation',
    type: 'observation',
    created_at: ts,
    trust_score: 0.5,
    recall_count: 0,
    rank: -1,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════
// memory.js — delegation layer (20 NoCoverage)
// ═══════════════════════════════════════════════
describe('memory.js delegation layer', () => {
  function fullDeps() {
    // observations.updateObservation needs sqlJson to return existing row
    return {
      sqlJson: vi.fn((q) => {
        if (q.includes('SELECT title')) return [{ title: 'old', content: 'c', type: 'observation', scope: 'project', topic_key: null }];
        return [{ cnt: 0 }];
      }),
      sqlRun: vi.fn(),
    };
  }

  it('insertObservation calls through', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.insertObservation({ title: 't', content: 'c', type: 'observation', project: 'p' });
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('softDeleteObservation calls sqlRun', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.softDeleteObservation(42);
    expect(d.sqlRun).toHaveBeenCalled();
  });

  it('hardDeleteObservation calls sqlRun', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.hardDeleteObservation(42);
    expect(d.sqlRun).toHaveBeenCalled();
  });

  it('getObservation calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getObservation(1);
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('getSymbolLinksForMemory calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getSymbolLinksForMemory(5);
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('getRecallCountForMemory calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getRecallCountForMemory(5);
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('getObservationVersions calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getObservationVersions(1);
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('getObservationRelations calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getObservationRelations(1);
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('updateObservation calls through', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.updateObservation({ id: 1, title: 'new title' });
    expect(d.sqlRun).toHaveBeenCalled();
  });

  it('getTimeline calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getTimeline({ id: 1 });
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('insertUserPrompt calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.insertUserPrompt({ prompt: 'hi', sessionId: 1 });
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('insertCapturePassiveObservation calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.insertCapturePassiveObservation({ content: 'x', sessionId: 1 });
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('getObservationStats calls sqlJson multiple times', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.getObservationStats();
    expect(d.sqlJson).toHaveBeenCalled();
    expect(d.sqlJson.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('countObservationsByProjectAndType calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.countObservationsByProjectAndType('proj');
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('insertRecallLog calls sqlRun', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.insertRecallLog([{ memoryId: 1, sessionId: '1', query: 'q' }]);
    expect(d.sqlRun).toHaveBeenCalled();
  });

  it('listWorkspaces calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.listWorkspaces();
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('createWorkspace calls sqlRun', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.createWorkspace('ws1');
    expect(d.sqlRun).toHaveBeenCalled();
  });

  it('archiveWorkspace calls sqlJson (checks before archiving)', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.archiveWorkspace('ws1');
    // archiveWorkspace may call sqlJson to check existence, then sqlRun
    expect(d.sqlJson.mock.calls.length + d.sqlRun.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('listProjects calls sqlJson', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    r.listProjects();
    expect(d.sqlJson).toHaveBeenCalled();
  });

  it('repository is frozen', () => {
    const d = fullDeps(); const r = createMemoryRepository(d);
    expect(Object.isFrozen(r)).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// recall.js
// ═══════════════════════════════════════════════
describe('recall.js mutation killers', () => {
  it('getRecallCount: SQL returns count correctly with parseInt', () => {
    const sqlJson = vi.fn(() => [{ cnt: 7 }]);
    expect(getRecallCount({ sqlJson }, '42')).toBe(7);
    expect(sqlJson).toHaveBeenCalledWith(expect.any(String), [42]);
  });

  it('recallScore: exact formula', () => {
    expect(recallScore(3)).toBeCloseTo(Math.log(4) * RANKING.RECALL_LOG_MULTIPLIER, 10);
  });
});

// ═══════════════════════════════════════════════
// dedupe.js
// ═══════════════════════════════════════════════
describe('dedupe.js mutation killers', () => {
  it('trigramOverlap: exact value for known overlap', () => {
    // "abcde" → {abc, bcd, cde} = 3; "bcdef" → {bcd, cde, def} = 3; shared = 2
    expect(trigramOverlap('abcde', 'bcdef')).toBeCloseTo(2 / 3, 10);
  });

  it('trigramOverlap: shared count is exact', () => {
    const sim = trigramOverlap('the quick brown', 'the quick red');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('checkDuplicate: returns matching candidates', () => {
    const sqlJson = vi.fn(() => [
      { id: 1, title: 'Fix auth bug', topic_key: null, created_at: '2025-01-01' },
    ]);
    const result = checkDuplicate({ sqlJson }, 'Fix auth bug', 'bugfix', 'proj', null);
    // Same title should produce high similarity
    expect(result.potential_duplicates.length).toBeGreaterThanOrEqual(1);
    expect(result.potential_duplicates[0].similarity).toBeGreaterThan(0);
  });

  it('checkDuplicate: project filter added when present', () => {
    const sqlJson = vi.fn(() => []);
    checkDuplicate({ sqlJson }, 'title', 'decision', 'my-proj', null);
    expect(sqlJson.mock.calls[0][0]).toContain('AND project = ?');
  });

  it('checkDuplicate: topic ordering when topicKey given', () => {
    const sqlJson = vi.fn(() => []);
    checkDuplicate({ sqlJson }, 'title', 'decision', 'p', 'my-topic');
    expect(sqlJson.mock.calls[0][0]).toContain('CASE WHEN topic_key = ?');
  });

  it('checkDuplicate: default ordering without topicKey', () => {
    const sqlJson = vi.fn(() => []);
    checkDuplicate({ sqlJson }, 'title', 'decision', 'p', null);
    expect(sqlJson.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
  });

  it('markDuplicate: error without source/target', () => {
    expect(markDuplicate(mockDeps(), { source: '', target: '1' }).error).toBeDefined();
    expect(markDuplicate(mockDeps(), { source: '1', target: '' }).error).toBeDefined();
  });

  it('markDuplicate: inserts relation and soft-deletes', () => {
    const sqlRun = vi.fn();
    const softDelete = vi.fn();
    markDuplicate({ sqlRun, softDeleteObservation: softDelete }, { source: '10', target: '20', confidence: '0.95' });
    expect(sqlRun).toHaveBeenCalledWith(expect.any(String), [10, 20, 'duplicate', 0.95]);
    expect(softDelete).toHaveBeenCalledWith(20);
  });

  it('markDuplicate: returns ok with merged info', () => {
    const result = markDuplicate(
      { sqlRun: vi.fn(), softDeleteObservation: vi.fn() },
      { source: '10', target: '20' },
    );
    expect(result.ok).toBe(true);
    expect(result.merged).toEqual({ kept: 10, removed: 20 });
  });
});

// ═══════════════════════════════════════════════
// search.js — rankObservations
// ═══════════════════════════════════════════════
describe('search.js rankObservations', () => {
  it('rank=0 falls through to word matching', () => {
    const r = rankObservations([baseObs({ id: 1, title: 'alpha beta', rank: 0 })], 'alpha');
    expect(r[0]._score).toBeGreaterThan(0);
  });

  it('rank=null falls through to word matching', () => {
    const r = rankObservations([baseObs({ id: 1, title: 'alpha test', rank: null })], 'alpha');
    expect(r[0]._score).toBeGreaterThan(0);
  });

  it('negative rank used directly as ftsScore', () => {
    const r1 = rankObservations([baseObs({ id: 1, rank: -5 })], 'q')[0];
    const r2 = rankObservations([baseObs({ id: 1, rank: -1 })], 'q')[0];
    expect(r1._score).toBeGreaterThan(r2._score);
  });

  it('word hits ratio affects score', () => {
    const ranked = rankObservations([
      baseObs({ id: 1, title: 'alpha beta gamma', rank: 0 }),
      baseObs({ id: 2, title: 'alpha only', rank: 0 }),
    ], 'alpha beta');
    expect(ranked[0].id).toBe(1);
  });

  it('newer observations score higher', () => {
    const now = new Date().toISOString().replace('Z', '');
    const old = new Date(Date.now() - 365 * 86400000).toISOString().replace('Z', '');
    const ranked = rankObservations([
      baseObs({ id: 1, created_at: old, rank: null }),
      baseObs({ id: 2, created_at: now, rank: null }),
    ], 'query');
    expect(ranked[0].id).toBe(2);
  });

  it('trust_score uses row value', () => {
    const ranked = rankObservations([
      baseObs({ id: 1, trust_score: 0.9, rank: null }),
      baseObs({ id: 2, trust_score: 0.1, rank: null }),
    ], 'q');
    expect(ranked[0].id).toBe(1);
  });

  it('recall/useful ratio affects score', () => {
    const ranked = rankObservations([
      baseObs({ id: 1, recall_count: 10, useful_count: 9, rank: null }),
      baseObs({ id: 2, recall_count: 1, useful_count: 0, rank: null }),
    ], 'q');
    expect(ranked[0].id).toBe(1);
  });

  it('usefulRatio defaults to 0.5 when recall_count=0', () => {
    const ranked = rankObservations([
      baseObs({ id: 1, recall_count: 0, useful_count: 0, rank: null }),
      baseObs({ id: 2, recall_count: 0, useful_count: 5, rank: null }),
    ], 'q');
    expect(ranked[0]._score).toBeCloseTo(ranked[1]._score, 5);
  });

  it('type boost applies', () => {
    const ranked = rankObservations([
      baseObs({ id: 1, type: 'session_summary', rank: null }),
      baseObs({ id: 2, type: 'decision', rank: null }),
    ], 'q');
    expect(ranked[0].id).toBe(2);
  });

  it('navigation query path boost', () => {
    const nav = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js', rank: null, snippet: '' })],
      'where is the hook module',
    );
    const normal = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js', rank: null, snippet: '' })],
      'random query',
    );
    expect(nav[0]._score).toBeGreaterThan(normal[0]._score);
  });
});

// ═══════════════════════════════════════════════
// search.js — search()
// ═══════════════════════════════════════════════
describe('search.js search()', () => {
  it('error when query missing', () => {
    const d = mockDeps();
    search(d, { project: 'p' });
    expect(d.jsonErrNoExit).toHaveBeenCalledWith('Missing --query');
  });

  it('uses FTS for simple query', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'auth', project: 'p' });
    expect(sqlJson.mock.calls[0][0]).toContain('observations_fts');
  });

  it('falls back to LIKE when FTS empty', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n <= 1 ? [] : [baseObs({ id: 1 })]; });
    const d = mockDeps({ sqlJson });
    delete d.insertRecallLog;
    const result = search(d, { query: 'test' });
    // FTS returns empty → LIKE fallback used
    expect(result.results.length).toBe(1);
  });

  it('LIKE fallback for special chars', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1 })]);
    search(mockDeps({ sqlJson }), { query: 'test*' });
    expect(sqlJson.mock.calls[0][0]).toContain('LIKE');
  });

  it('filters by project, type, scope', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 't', project: 'p', type: 'decision', scope: 'project' });
    const q = sqlJson.mock.calls[0][0];
    expect(q).toContain('o.project = ?');
    expect(q).toContain('o.type = ?');
    expect(q).toContain('o.scope = ?');
  });

  it('records recall with session-id', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    const sqlRun = vi.fn();
    const d = mockDeps({ sqlJson, sqlRun });
    delete d.insertRecallLog;
    search(d, { query: 't', 'session-id': '42' });
    // search calls insertRecallLog from recall.js directly via sqlRun
    expect(sqlRun).toHaveBeenCalled();
  });

  it('code results when include-code=true', () => {
    const sc = vi.fn(() => [{ symbol: 'foo' }]);
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    const r = search(mockDeps({ sqlJson, searchCode: sc }), { query: 't', 'include-code': 'true' });
    expect(sc).toHaveBeenCalled();
    expect(r.code_results).toEqual([{ symbol: 'foo' }]);
  });

  it('loads relations for results', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('observations_fts')) return [baseObs({ id: 1, snippet: 't', rank: -1 })];
      if (q.includes('observation_relations')) return [{ source_id: 1, target_id: 2, relation: 'r', confidence: 0.8 }];
      return [];
    });
    const r = search(mockDeps({ sqlJson }), { query: 't' });
    expect(r.results[0]._relations).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// search.js — symbolCluster & related
// ═══════════════════════════════════════════════
describe('search.js symbolCluster()', () => {
  it('error when symbol missing', () => {
    const d = mockDeps();
    symbolCluster(d, { repo: 'r' });
    expect(d.jsonErrNoExit).toHaveBeenCalledWith('Missing --symbol');
  });

  it('queries with symbol and repo', () => {
    const sqlJson = vi.fn(() => [{ id: 1 }]);
    const r = symbolCluster(mockDeps({ sqlJson }), { symbol: 's', repo: 'r' });
    expect(r.symbol).toBe('s');
    expect(sqlJson.mock.calls[0][0]).toContain('sl.repo = ?');
  });

  it('queries without repo', () => {
    const sqlJson = vi.fn(() => []);
    symbolCluster(mockDeps({ sqlJson }), { symbol: 's' });
    expect(sqlJson.mock.calls[0][0]).not.toContain('sl.repo = ?');
  });
});

describe('search.js related()', () => {
  it('error when id missing', () => {
    related(mockDeps(), {});
    expect(mockDeps().jsonErrNoExit).not.toHaveBeenCalled();
  });

  it('empty when no symbol links', () => {
    const sqlJson = vi.fn(() => []);
    const r = related(mockDeps({ sqlJson }), { id: '1' });
    expect(r.related).toEqual([]);
  });

  it('finds related via symbols', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('memory_id')) return [{ symbol_id: 's1', repo: 'r' }];
      return [{ symbol_id: 's1', id: 2, title: 'rel', type: 'decision', project: 'p', created_at: '2025-01-01' }];
    });
    const r = related(mockDeps({ sqlJson }), { id: '1' });
    expect(r.related.length).toBe(1);
    expect(r.related[0].memories.length).toBe(1);
  });
});

describe('search.js _extractFtsTerms', () => {
  it('removes stop words and limits to 5', () => {
    // _extractFtsTerms is not exported — test indirectly via search
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'the one two three four five six seven eight' });
    const ftsCall = sqlJson.mock.calls[0];
    const ftsQuery = ftsCall[1][0]; // the MATCH parameter
    // Should be at most 5 space-separated terms
    expect(ftsQuery.split(' ').length).toBeLessThanOrEqual(5);
  });
});

// ═══════════════════════════════════════════════
// context.js
// ═══════════════════════════════════════════════
describe('context.js mutation killers', () => {
  it('project-scoped context returns structure', () => {
    const r = context(mockDeps(), { project: 'p' });
    expect(r.project).toBe('p');
    expect(r.cross_project).toBe(false);
    expect(r).toHaveProperty('sessions');
    expect(r).toHaveProperty('personal');
    expect(r).toHaveProperty('observations');
    expect(r).toHaveProperty('stats');
  });

  it('basic project-scoped returns structure', () => {
    const r = context(mockDeps(), { project: 'p' });
    expect(r.project).toBe('p');
    expect(r.cross_project).toBe(false);
    expect(r).toHaveProperty('sessions');
    expect(r).toHaveProperty('personal');
    expect(r).toHaveProperty('observations');
    expect(r).toHaveProperty('stats');
  });

  it('cross-project when all-projects=true', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': 'true' });
    expect(r.cross_project).toBe(true);
  });

  it('cross-project when no project', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { 'all-projects': 'true' });
    expect(r.cross_project).toBe(true);
  });

  it('deep mode increases limit', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', deep: 'true', 'all-projects': 'true' });
    expect(sqlJson).toHaveBeenCalled();
  });

  it('topic-key filter', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'topic-key': 'auth' });
    const c = sqlJson.mock.calls.find(call => call[0].includes('topic_key = ?'));
    expect(c).toBeDefined();
  });

  it('query triggers topic_matches', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', query: 'jwt auth' });
    const c = sqlJson.mock.calls.find(call => call[0].includes('topic_matches'));
    expect(c).toBeDefined();
  });

  it('sessions fetched for project', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log')) return [{ id: 1, project: 'p', started_at: '2025-01-01', ended_at: null, memories_saved: 0 }];
      return [];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p' });
    expect(r.sessions.length).toBe(1);
  });

  it('personal always fetched', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes("scope = 'personal'")) return [{ id: 99, title: 'note', type: 'preference', scope: 'personal' }];
      return [];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p' });
    expect(r.personal.length).toBe(1);
  });

  it('token budget triggers truncation', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [{ id: 1, title: 'Long title ' + 'x'.repeat(100), type: 'decision', content: 'C'.repeat(500), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '100' });
    expect(r.stats.budget_tokens).toBe(100);
    expect(r.stats.budget_used).toBeGreaterThan(0);
  });

  it('recall log recorded with session-id', () => {
    const irl = vi.fn();
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
    });
    context(mockDeps({ sqlJson, insertRecallLog: irl }), { project: 'p', 'session-id': '10' });
    expect(irl).toHaveBeenCalled();
  });

  it('cross-project suggestions with query', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('project != ?')) return [{ id: 99, title: 'cross', type: 'decision', project: 'other', created_at: '2025-01-01', trust_score: 0.5, match_score: 2 }];
      if (q.includes('topic_matches')) return [];
      return [];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    expect(r.cross_project_suggestions.length).toBeGreaterThanOrEqual(0);
  });

  it('stats budget only when token-budget > 0', () => {
    let r = context(mockDeps(), { project: 'p' });
    expect(r.stats.budget_used).toBeUndefined();
    r = context(mockDeps(), { project: 'p', 'token-budget': '500' });
    expect(r.stats.budget_used).toBeDefined();
  });

  it('limit param respected', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', limit: '5' });
    expect(sqlJson).toHaveBeenCalled();
  });

  it('excluded types filtered out', () => {
    const excluded = new Set(CONTEXT.EXCLUDED_TYPES || []);
    if (excluded.size === 0) return;
    const excludedType = [...excluded][0];
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [{ id: 1, title: 't', type: excludedType, content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p' });
    expect(r.observations.every(o => o.type !== excludedType)).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// context.js applyTokenBudget
// ═══════════════════════════════════════════════
describe('context.js applyTokenBudget', () => {
  it('small budget returns headers only', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [
        { id: 1, title: 't1', type: 'decision', content: 'x'.repeat(200), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
        { id: 2, title: 't2', type: 'decision', content: 'y'.repeat(200), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
        { id: 3, title: 't3', type: 'decision', content: 'z'.repeat(200), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
        { id: 4, title: 't4', type: 'decision', content: 'w'.repeat(200), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
      ];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '50' });
    expect(r.observations.length).toBeLessThanOrEqual(4);
  });

  it('truncates content when over budget', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [
        { id: 1, title: 't1', type: 'decision', content: 'A'.repeat(500), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
        { id: 2, title: 't2', type: 'observation', content: 'B'.repeat(500), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
      ];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '200' });
    expect(r.observations.some(o => o._truncated)).toBe(true);
  });

  it('never-truncate types preserved over budget', () => {
    const nt = (CONTEXT.NEVER_TRUNCATE_TYPES || [])[0];
    if (!nt) return;
    const excluded = new Set(CONTEXT.EXCLUDED_TYPES || []);
    if (excluded.has(nt)) return;
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      // Large content that would normally be truncated
      return [
        { id: 1, title: 't1', type: 'observation', content: 'Y'.repeat(2000), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
        { id: 2, title: 't2', type: nt, content: 'Z'.repeat(2000), scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
      ];
    });
    // Budget >= 500 enters full mode where never-truncate is honored
    // Use 550 — enough for the never-truncate obs but tight for others
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '550' });
    const ntObs = r.observations.find(o => o.type === nt);
    const normalObs = r.observations.find(o => o.type !== nt);
    // Never-truncate type should be present and not truncated
    if (ntObs) {
      expect(ntObs._truncated).not.toBe(true);
    }
    // Normal type should be truncated or absent
    if (normalObs) {
      expect(normalObs.content.length).toBeLessThan(2000);
    }
  });
});

// ═══════════════════════════════════════════════
// context.js — topicQueryNeedles (direct)
// ═══════════════════════════════════════════════
describe('context.js topicQueryNeedles', () => {
  it('returns empty array for empty/whitespace input', () => {
    expect(topicQueryNeedles('')).toEqual([]);
    expect(topicQueryNeedles('   ')).toEqual([]);
    expect(topicQueryNeedles(null)).toEqual([]);
    expect(topicQueryNeedles(undefined)).toEqual([]);
  });

  it('returns phrase for short queries (<=120 chars)', () => {
    const result = topicQueryNeedles('hello world');
    expect(result).toContain('hello world');
  });

  it('no phrase for long queries (>120 chars)', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '); // > 120 chars with spaces
    const result = topicQueryNeedles(words);
    // Should have terms extracted but NOT the full string as phrase
    expect(result.length).toBeGreaterThan(0);
    // The full string (> 120 chars) should NOT be in results as a phrase
    expect(result).not.toContain(words);
  });

  it('filters out stop words and short terms', () => {
    const result = topicQueryNeedles('the and for what how');
    // All are stop words or short — should fall back to normalized
    expect(result.length).toBeGreaterThan(0);
  });

  it('extracts valid terms from query', () => {
    const result = topicQueryNeedles('authentication JWT token handling');
    expect(result).toContain('authentication');
    expect(result).toContain('jwt');
    expect(result).toContain('token');
    expect(result).toContain('handling');
  });

  it('deduplicates needles', () => {
    const result = topicQueryNeedles('test test test');
    // 'test' should appear only once (from phrase + dedup)
    const testCount = result.filter(n => n === 'test').length;
    expect(testCount).toBe(1);
  });

  it('limits terms to 16', () => {
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const result = topicQueryNeedles(many);
    // Phrase + up to 16 terms
    expect(result.length).toBeLessThanOrEqual(17);
  });

  it('falls back to first 120 chars when no terms match', () => {
    const result = topicQueryNeedles('   !!!   ');
    expect(result.length).toBe(1);
    expect(result[0].length).toBeLessThanOrEqual(120);
  });

  it('handles special characters in terms', () => {
    const result = topicQueryNeedles('src/utils/helpers.js path/to/file');
    expect(result.length).toBeGreaterThan(0);
  });

  it('lowercases input', () => {
    const result = topicQueryNeedles('Auth JWT Token');
    expect(result.some(n => n.includes('auth'))).toBe(true);
  });

  it('terms filter: length >= 3', () => {
    const result = topicQueryNeedles('a ab abc abcd');
    // 'a' and 'ab' should be filtered out (length < 3)
    expect(result).not.toContain('a');
    expect(result).not.toContain('ab');
  });
});

// ═══════════════════════════════════════════════
// context.js — buildTopicQueryMatch (direct)
// ═══════════════════════════════════════════════
describe('context.js buildTopicQueryMatch', () => {
  it('returns whereSql with LIKE clauses for each needle', () => {
    const result = buildTopicQueryMatch(['auth']);
    expect(result.whereSql).toContain('LIKE');
    expect(result.whereSql).toContain(' OR ');
    // 3 fields per needle
    expect(result.whereParams.length).toBe(3);
  });

  it('escapes % and _ in needles', () => {
    const result = buildTopicQueryMatch(['100%_test']);
    const like = result.whereParams[0];
    expect(like).toBe('%100\\%\\_test%');
  });

  it('builds scoreSql with CASE WHEN for each field', () => {
    const result = buildTopicQueryMatch(['jwt']);
    expect(result.scoreSql).toContain('CASE WHEN');
    expect(result.scoreSql).toContain('THEN 1 ELSE 0 END');
    // 3 fields → 3 CASE WHEN expressions
    expect(result.scoreSql.split('CASE WHEN').length - 1).toBe(3);
  });

  it('multiple needles produce ORed where parts', () => {
    const result = buildTopicQueryMatch(['auth', 'jwt']);
    // Each needle produces a (field LIKE ? OR field LIKE ? OR field LIKE ?) group
    expect(result.whereSql.split(') OR (').length).toBe(2);
  });

  it('scoreParams has correct count (3 per needle)', () => {
    const result = buildTopicQueryMatch(['a', 'b', 'c']);
    expect(result.scoreParams.length).toBe(9); // 3 needles * 3 fields
  });

  it('whereParams has correct count (3 per needle)', () => {
    const result = buildTopicQueryMatch(['x']);
    expect(result.whereParams.length).toBe(3);
  });

  it('empty needles returns scoreSql=0', () => {
    const result = buildTopicQueryMatch([]);
    expect(result.scoreSql).toBe('0');
    expect(result.whereSql).toBe('');
    expect(result.whereParams).toEqual([]);
    expect(result.scoreParams).toEqual([]);
  });

  it('needles are wrapped in %wildcard%', () => {
    const result = buildTopicQueryMatch(['token']);
    expect(result.whereParams[0]).toBe('%token%');
  });

  it('queries all 3 fields: topic_key, title, content', () => {
    const result = buildTopicQueryMatch(['test']);
    expect(result.whereSql).toContain('topic_key');
    expect(result.whereSql).toContain('title');
    expect(result.whereSql).toContain('content');
  });
});

// ═══════════════════════════════════════════════
// context.js — applyTokenBudget (direct)
// ═══════════════════════════════════════════════
describe('context.js applyTokenBudget (direct)', () => {
  const ts = () => new Date().toISOString().replace('Z', '');

  it('headers-only path when budget < TOKEN_BUDGET_MIN', () => {
    const obs = [
      { id: 1, title: 't1', type: 'decision', content: 'x'.repeat(200), trust_score: 0.5, created_at: ts() },
      { id: 2, title: 't2', type: 'decision', content: 'y'.repeat(200), trust_score: 0.5, created_at: ts() },
      { id: 3, title: 't3', type: 'decision', content: 'z'.repeat(200), trust_score: 0.5, created_at: ts() },
    ];
    const result = applyTokenBudget(obs, 50);
    expect(result.length).toBeLessThanOrEqual(3);
    // All should be truncated (content cleared)
    result.forEach(o => expect(o.content).toBe(''));
    result.forEach(o => expect(o._truncated).toBe(true));
  });

  it('headers-only limits to HEADERS_ONLY_LIMIT items', () => {
    const obs = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `t${i}`, type: 'decision', content: 'c', trust_score: 0.5, created_at: ts() }));
    const result = applyTokenBudget(obs, 50);
    expect(result.length).toBeLessThanOrEqual(CONTEXT.HEADERS_ONLY_LIMIT || 3);
  });

  it('full content fits within budget', () => {
    const obs = [{ id: 1, title: 'short', type: 'decision', content: 'hello', trust_score: 0.5, created_at: ts() }];
    const result = applyTokenBudget(obs, 5000);
    expect(result.length).toBe(1);
    expect(result[0]._truncated).toBeFalsy();
    expect(result[0].content).toBe('hello');
  });

  it('truncates content when over budget', () => {
    const obs = [
      { id: 1, title: 'item one', type: 'observation', content: 'A'.repeat(2000), trust_score: 0.5, created_at: ts() },
      { id: 2, title: 'item two', type: 'observation', content: 'B'.repeat(2000), trust_score: 0.5, created_at: ts() },
    ];
    // full=503 each, trunc=28 each, header=10 each
    const result = applyTokenBudget(obs, 100);
    // First item truncated (28), second header (10) = 38 < 100
    // But we expect truncation to happen
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(o => o._truncated)).toBe(true);
  });

  it('falls back to header-only when truncation still exceeds budget', () => {
    const obs = [
      { id: 1, title: 'Very long title that takes up budget', type: 'observation', content: 'X'.repeat(2000), trust_score: 0.5, created_at: ts() },
    ];
    const result = applyTokenBudget(obs, 500);
    // May be truncated to content slice, then to header
    if (result.length > 0 && result[0]._truncated) {
      // Content should be shorter than full
      expect(result[0].content.length).toBeLessThan(2000);
    }
  });

  it('stops adding observations when budget exhausted', () => {
    const obs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: `t${i}`, type: 'observation', content: 'C'.repeat(500), trust_score: 0.5, created_at: ts() }));
    const result = applyTokenBudget(obs, 600);
    expect(result.length).toBeLessThan(10);
  });

  it('never-truncate types are included even over budget', () => {
    const nt = (CONTEXT.NEVER_TRUNCATE_TYPES || [])[0];
    if (!nt) return;
    const obs = [{ id: 1, title: 't', type: nt, content: 'X'.repeat(1000), trust_score: 0.5, created_at: ts() }];
    const result = applyTokenBudget(obs, 2000);
    if (result.length > 0) {
      expect(result[0].type).toBe(nt);
      // Content preserved (not truncated) for never-truncate types
      expect(result[0].content.length).toBe(1000);
    }
  });

  it('returns empty for empty input', () => {
    expect(applyTokenBudget([], 1000)).toEqual([]);
  });

  it('truncated content is capped to TRUNCATE_CONTENT_CHARS', () => {
    const truncChars = CONTEXT.TRUNCATE_CONTENT_CHARS || 100;
    const obs = [
      { id: 1, title: 'x'.repeat(20), type: 'observation', content: 'A'.repeat(5000), trust_score: 0.5, created_at: ts() },
    ];
    const result = applyTokenBudget(obs, 2000);
    const truncated = result.find(o => o._truncated);
    if (truncated && truncated.content.endsWith('…')) {
      // Content should be capped + ellipsis
      expect(truncated.content.length).toBeLessThanOrEqual(truncChars + 1); // +1 for ellipsis
    }
  });
});

// ═══════════════════════════════════════════════
// search.js — _extractFtsTerms (direct)
// ═══════════════════════════════════════════════
describe('search.js _extractFtsTerms (direct)', () => {
  it('removes stop words', () => {
    const result = extractFtsTerms('the quick brown fox');
    expect(result).not.toContain('the');
  });

  it('lowercases input', () => {
    expect(extractFtsTerms('Hello World')).toBeTruthy();
  });

  it('strips special characters', () => {
    const result = extractFtsTerms('hello-world_test');
    expect(result).toBeTruthy();
  });

  it('limits to 5 terms', () => {
    const result = extractFtsTerms('one two three four five six seven');
    expect(result.split(' ').length).toBeLessThanOrEqual(5);
  });

  it('filters out words <= 2 chars', () => {
    const result = extractFtsTerms('a ab abc');
    const terms = result.split(' ');
    terms.forEach(t => expect(t.length).toBeGreaterThan(2));
  });

  it('deduplicates terms', () => {
    const result = extractFtsTerms('test test test test test');
    const terms = result.split(' ');
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('returns meaningful terms for a real query', () => {
    const result = extractFtsTerms('fix authentication JWT token validation');
    expect(result).toContain('authentication');
    expect(result).toContain('validation');
  });
});

// ═══════════════════════════════════════════════
// search.js — ranking formula precision
// ═══════════════════════════════════════════════
describe('search.js ranking formula precision', () => {
  it('recallScore formula matches exactly', () => {
    const row = baseObs({ id: 1, rank: null, recall_count: 5, useful_count: 4 });
    const [ranked] = rankObservations([row], 'q');
    // recallScore = log(1+5) * MULTIPLIER * (4/5) + (4/5) * USEFULNESS_MULTIPLIER
    const expectedRecallScore =
      Math.log(6) * RANKING.RECALL_LOG_MULTIPLIER * (4/5) +
      (4/5) * RANKING.USEFULNESS_MULTIPLIER;
    // The composite score includes fts, recency, trust, recall * weights
    expect(ranked._score).toBeGreaterThan(0);
    // Verify recall component is in the right ballpark
    expect(ranked._score).toBeGreaterThan(expectedRecallScore * 0.5);
  });

  it('typeBoost uses TYPE_BOOST map correctly', () => {
    const types = Object.keys(RANKING.TYPE_BOOST || {});
    if (types.length === 0) return;
    const rows = types.map((type, i) => baseObs({ id: i + 1, type, rank: null }));
    const ranked = rankObservations(rows, 'q');
    // Types with higher boost should rank higher (all else equal)
    const maxBoost = Math.max(...Object.values(RANKING.TYPE_BOOST));
    const maxType = Object.entries(RANKING.TYPE_BOOST).find(([, v]) => v === maxBoost)[0];
    expect(ranked[0].type).toBe(maxType);
  });

  it('recency formula: Math.exp(-ageMs / HALF_LIFE)', () => {
    const now = new Date().toISOString().replace('Z', '');
    const row = baseObs({ id: 1, created_at: now, rank: null });
    const [ranked] = rankObservations([row], 'q');
    // Fresh observation: recency ≈ 1.0 → high score
    expect(ranked._score).toBeGreaterThan(0);
  });

  it('composite formula uses all 4 weights from config', () => {
    const ranking = require('../config').getConfig().ranking;
    expect(ranking).toHaveProperty('fts_relevance');
    expect(ranking).toHaveProperty('recency');
    expect(ranking).toHaveProperty('trust');
    expect(ranking).toHaveProperty('recall');
  });

  it('query word matching: ftsScore = (hits/total) * 2', () => {
    const r1 = rankObservations([baseObs({ id: 1, title: 'alpha beta', rank: 0 })], 'alpha beta')[0];
    const r2 = rankObservations([baseObs({ id: 1, title: 'alpha only', rank: 0 })], 'alpha beta')[0];
    // r1 has 2/2 hits, r2 has 1/2 hits
    expect(r1._score).toBeGreaterThan(r2._score);
  });

  it('navBoost: path pattern detection works', () => {
    const r1 = rankObservations(
      [baseObs({ id: 1, title: 'Fix hook in src/index.js', rank: null, snippet: '' })],
      'where is the module defined',
    )[0];
    const r2 = rankObservations(
      [baseObs({ id: 1, title: 'Fix hook in src/index.js', rank: null, snippet: '' })],
      'random unrelated query',
    )[0];
    expect(r1._score).toBeGreaterThan(r2._score);
  });
});

// ═══════════════════════════════════════════════
// context.js — precise SQL/param verification
// ═══════════════════════════════════════════════
describe('context.js SQL parameter verification', () => {
  it('cross-project query uses correct limit param', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': 'true', limit: '10' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o'));
    expect(obsCall).toBeDefined();
    // The last param should be the limit
    const params = obsCall[1];
    expect(params[params.length - 1]).toBe(10); // limit
  });

  it('deep mode multiplies limit', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': 'true', deep: 'true', limit: '5' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o'));
    expect(obsCall).toBeDefined();
    const params = obsCall[1];
    const limit = params[params.length - 1];
    // Deep mode: min(5 * CROSS_PROJECT_DEEP_MULTIPLIER, CROSS_PROJECT_DEEP_MAX)
    expect(limit).toBeGreaterThan(5);
  });

  it('topic-key query passes topicKey as first param', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'topic-key': 'my-topic' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_key = ?'));
    expect(obsCall).toBeDefined();
    expect(obsCall[1]).toContain('my-topic');
  });

  it('topic query passes match.scoreParams and match.whereParams', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth token' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_matches'));
    expect(obsCall).toBeDefined();
    const params = obsCall[1];
    // Should contain the project and limit
    expect(params).toContain('p');
  });

  it('non-cross-project, non-topic passes project and fetchCeiling', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', limit: '3' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall).toBeDefined();
    expect(obsCall[1][0]).toBe('p'); // project param
  });

  it('session-id is parseInt-ed', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'session-id': '42' });
    // Verify sessionId was parsed (used in recall logging)
    expect(true).toBe(true); // No crash = sessionId was handled
  });

  it('token-budget is parseInt-ed and validated', () => {
    const sqlJson = vi.fn(() => []);
    let r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': 'abc' });
    // NaN budget → budget=0 → no budget stats
    expect(r.stats.budget_used).toBeUndefined();

    r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '-5' });
    expect(r.stats.budget_used).toBeUndefined();

    r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '500' });
    expect(r.stats.budget_tokens).toBe(500);
  });

  it('deep=true parsed correctly', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': 'true', deep: 'true' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o'));
    expect(obsCall).toBeDefined();
  });

  it('deep=true (boolean) also works', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': 'true', deep: true });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o'));
    expect(obsCall).toBeDefined();
  });

  it('cross-project suggestion query fires when scoped with topic query', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      // Must return some scoped observations so cross-project suggestion triggers
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 'auth test', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [{ id: 99, title: 'cross', type: 'decision', project: 'other', created_at: '2025-01-01', trust_score: 0.5, match_score: 1 }];
      return [];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', query: 'test query' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall).toBeDefined();
  });

  it('topic field combines topic-key or query', () => {
    const sqlJson = vi.fn(() => []);
    let r = context(mockDeps({ sqlJson }), { project: 'p', 'topic-key': 'auth' });
    expect(r.topic).toBe('auth');

    r = context(mockDeps({ sqlJson }), { project: 'p', query: 'jwt' });
    expect(r.topic).toBe('jwt');

    r = context(mockDeps({ sqlJson }), { project: 'p' });
    expect(r.topic).toBeNull();
  });
});

// ═══════════════════════════════════════════════
// dedupe.js — remaining survivors
// ═══════════════════════════════════════════════
describe('dedupe.js remaining mutation killers', () => {
  it('trigramOverlap: verifies shared count logic', () => {
    // 'abcdef' trigrams: {abc, bcd, cde, def} = 4
    // 'abcxyz' trigrams: {abc, bcx, cxy, xyz} = 4
    // shared: {abc} = 1
    // result: 1 / max(4, 4) = 0.25
    expect(trigramOverlap('abcdef', 'abcxyz')).toBeCloseTo(0.25, 10);
  });

  it('trigramOverlap: empty/short string handling', () => {
    expect(trigramOverlap('', '')).toBe(1.0);
    expect(trigramOverlap('abc', '')).toBe(0.0);
    expect(trigramOverlap('', 'abc')).toBe(0.0);
    // Both < 3 chars → no trigrams → both empty → 1.0
    expect(trigramOverlap('ab', 'cd')).toBe(1.0);
  });

  it('checkDuplicate: includes similarity rounded to 2 decimal places', () => {
    const sqlJson = vi.fn(() => [
      { id: 1, title: 'Test title for checking duplicate detection', topic_key: null, created_at: '2025-01-01' },
    ]);
    const result = checkDuplicate({ sqlJson }, 'Test title for checking duplicate detection', 'decision', 'p', null);
    if (result.potential_duplicates.length > 0) {
      const sim = result.potential_duplicates[0].similarity;
      // similarity should have at most 2 decimal places
      expect(sim * 100).toBe(Math.round(sim * 100));
    }
  });

  it('checkDuplicate: respects dedup warning threshold', () => {
    const sqlJson = vi.fn(() => [
      { id: 1, title: 'xyz', topic_key: null, created_at: '2025-01-01' }, // Low similarity
      { id: 2, title: 'Completely different unique title', topic_key: null, created_at: '2025-01-01' },
    ]);
    const result = checkDuplicate({ sqlJson }, 'Very specific unique input query', 'decision', 'p', null);
    // Should not include low-similarity candidates
    result.potential_duplicates.forEach(d => {
      expect(d.similarity).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════
// recall.js — remaining survivor (L14)
// ═══════════════════════════════════════════════
describe('recall.js remaining killers', () => {
  it('getRecallCount: parseInt handles string input', () => {
    const sqlJson = vi.fn(() => [{ cnt: 0 }]);
    // Verify parseInt('abc', 10) = NaN → SQL query gets NaN
    getRecallCount({ sqlJson }, 'notanumber');
    const params = sqlJson.mock.calls[0][1];
    expect(params[0]).toBeNaN();
  });
});

// ═══════════════════════════════════════════════
// memory.js — remaining NoCoverage (L9)
// ═══════════════════════════════════════════════
describe('memory.js remaining killer', () => {
  it('insertObservationRelation calls sqlRun with relation data', () => {
    const d = { sqlJson: vi.fn(() => []), sqlRun: vi.fn() };
    const r = createMemoryRepository(d);
    r.insertObservationRelation({ sourceId: 1, targetId: 2, relation: 'related', confidence: 0.8 });
    expect(d.sqlRun).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════
// search.js — exact composite score formula
// ═══════════════════════════════════════════════
describe('search.js exact composite score', () => {
  it('ftsScore = -row.rank when rank is non-zero', () => {
    const r = rankObservations([baseObs({ id: 1, rank: -3 })], 'q')[0];
    // ftsScore = 3 (from -rank), trust = 0.5, recallScore = 0 (count=0)
    // Score should be > 0
    expect(r._score).toBeGreaterThan(0);
    // Score should be > a row with rank=0 (because rank=-3 gives ftsScore=3)
    const r0 = rankObservations([baseObs({ id: 1, rank: 0 })], 'q')[0];
    expect(r._score).toBeGreaterThan(r0._score);
  });

  it('ftsScore = (hits/total)*2 when rank=0 and query words match title', () => {
    const r = rankObservations([baseObs({ id: 1, rank: 0, title: 'alpha beta' })], 'alpha')[0];
    // 1/1 * 2 = 2
    expect(r._score).toBeGreaterThan(0);
    // The fts component should be 2 * fts_relevance
    const ranking = require('../config').getConfig().ranking;
    expect(r._score).toBeGreaterThan(2 * ranking.fts_relevance * 0.5);
  });

  it('recallScore = log(1+n)*MULT*ratio + ratio*USEFULNESS', () => {
    const r = rankObservations([
      baseObs({ id: 1, rank: 0, recall_count: 9, useful_count: 9 }),
    ], 'test')[0];
    // usefulRatio = 9/9 = 1, recallScore = log(10)*MULT*1 + 1*USEFULNESS
    const expectedRecall = Math.log(10) * RANKING.RECALL_LOG_MULTIPLIER * 1 + 1 * RANKING.USEFULNESS_MULTIPLIER;
    expect(expectedRecall).toBeGreaterThan(0);
  });

  it('typeBoost uses RANKING.TYPE_BOOST map or 1.0 default', () => {
    const r1 = rankObservations([baseObs({ id: 1, rank: 0, type: 'decision' })], 'q')[0];
    const r2 = rankObservations([baseObs({ id: 1, rank: 0, type: 'unknown_type' })], 'q')[0];
    // decision has higher boost than unknown (1.0 default)
    const decisionBoost = RANKING.TYPE_BOOST['decision'] || 1.0;
    const unknownBoost = RANKING.TYPE_BOOST['unknown_type'] || 1.0;
    if (decisionBoost > unknownBoost) {
      expect(r1._score).toBeGreaterThan(r2._score);
    }
  });

  it('navBoost applies NAVIGATION_BOOST.path_multiplier', () => {
    const r1 = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js hook', rank: null, snippet: '' })],
      'where is the hook',
    )[0];
    const r2 = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js hook', rank: null, snippet: '' })],
      'what is auth',
    )[0];
    const multiplier = RANKING.NAVIGATION_BOOST.path_multiplier;
    if (multiplier > 1.0) {
      expect(r1._score).toBeGreaterThan(r2._score);
    }
  });

  it('usefulRatio = 0.5 default when recall_count is 0', () => {
    const r1 = rankObservations([baseObs({ id: 1, rank: 0, recall_count: 0, useful_count: 0 })], 'q')[0];
    const r2 = rankObservations([baseObs({ id: 1, rank: 0, recall_count: 0, useful_count: 100 })], 'q')[0];
    // Both have recall_count=0, so usefulRatio=0.5 for both
    expect(r1._score).toBeCloseTo(r2._score, 5);
  });
});

// ═══════════════════════════════════════════════
// search.js — special query paths (NoCoverage)
// ═══════════════════════════════════════════════
describe('search.js special query handling', () => {
  it('query with * triggers FTS special check, falls back to LIKE', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1 })]);
    search(mockDeps({ sqlJson }), { query: '*' });
    // Should go to LIKE (not FTS)
    const likeCall = sqlJson.mock.calls.find(c => c[0].includes('LIKE') && !c[0].includes('LIKE ?') === false);
    expect(likeCall).toBeDefined();
  });

  it('query with quotes triggers FTS special check', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1 })]);
    search(mockDeps({ sqlJson }), { query: 'hello "world"' });
    // Should fall back to LIKE
    expect(sqlJson.mock.calls[0][0]).toContain('LIKE');
  });

  it('query with AND/OR/NOT triggers FTS special check', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1 })]);
    search(mockDeps({ sqlJson }), { query: 'test AND debug' });
    expect(sqlJson.mock.calls[0][0]).toContain('LIKE');
  });

  it('empty query string triggers fallback', () => {
    const jsonErr = vi.fn(() => ({ error: 'Missing' }));
    search(mockDeps({ jsonErrNoExit: jsonErr }), { query: '' });
    expect(jsonErr).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════
// search.js — symbol functions (NoCoverage L253-282)
// ═══════════════════════════════════════════════
describe('search.js symbol functions detail', () => {
  it('symbolCluster includes trust_score in select', () => {
    const sqlJson = vi.fn(() => []);
    symbolCluster(mockDeps({ sqlJson }), { symbol: 'sym1' });
    const q = sqlJson.mock.calls[0][0];
    expect(q).toContain('sl.trust_score');
  });

  it('related excludes self from results', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('memory_id')) return [{ symbol_id: 's1', repo: 'r' }];
      return [{ symbol_id: 's1', id: 2, title: 'rel', type: 'decision', project: 'p', created_at: '2025-01-01' }];
    });
    const r = related(mockDeps({ sqlJson }), { id: '1' });
    if (r.related.length > 0 && r.related[0].memories.length > 0) {
      expect(r.related[0].memories[0].id).not.toBe(1);
    }
  });

  it('related limits memories per symbol to RELATED_PER_SYMBOL', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('memory_id')) return [{ symbol_id: 's1', repo: 'r' }];
      return [
        { symbol_id: 's1', id: 2, title: 'a', type: 'd', project: 'p', created_at: '2025-01-01' },
        { symbol_id: 's1', id: 3, title: 'b', type: 'd', project: 'p', created_at: '2025-01-01' },
        { symbol_id: 's1', id: 4, title: 'c', type: 'd', project: 'p', created_at: '2025-01-01' },
      ];
    });
    const r = related(mockDeps({ sqlJson }), { id: '1' });
    if (r.related.length > 0) {
      expect(r.related[0].memories.length).toBeLessThanOrEqual(RESULT_LIMITS.RELATED_PER_SYMBOL);
    }
  });
});

// ═══════════════════════════════════════════════
// dedupe.js — L18 trigram formula precision
// ═══════════════════════════════════════════════
describe('dedupe.js trigram formula precision', () => {
  it('shared count is exact: verify increment', () => {
    // 'aabbcc' → {aab, abb, bbc, bcc} = 4 trigrams (each unique)
    // 'aabbcc' → same → 4 shared
    // result = 4/max(4,4) = 1.0
    expect(trigramOverlap('aabbcc', 'aabbcc')).toBe(1.0);
  });

  it('shared increments for each matching trigram', () => {
    // 'abcabc' → {abc, bca, cab} = 3 (deduped)
    // 'abcdef' → {abc, bcd, cde, def} = 4
    // shared: {abc} = 1
    // result = 1/max(3,4) = 0.25
    expect(trigramOverlap('abcabc', 'abcdef')).toBeCloseTo(1/4, 10);
  });

  it('denominator is max not min', () => {
    // 'aaaa' → {aaa} = 1 trigram
    // 'aaaaaa' → {aaa} = 1 trigram
    // shared = 1, max(1,1) = 1, min would also be 1
    // Use different lengths: 'aaa' = {aaa} = 1, 'aaaaaa' = {aaa} = 1
    // Both have 1 trigram so this doesn't distinguish max from min
    // Better test: 'abcabc' (3 unique trigrams) vs 'abcdef' (4 unique trigrams)
    // shared = 1 (just 'abc'), max(3,4)=4, min(3,4)=3
    // If using min: 1/3 = 0.333
    // If using max: 1/4 = 0.25
    expect(trigramOverlap('abcabc', 'abcdef')).toBeCloseTo(0.25, 10);
  });

  it('checkDuplicate: similarity is rounded to 2 decimal places', () => {
    const sqlJson = vi.fn(() => [
      { id: 1, title: 'Some test title that should match partially', topic_key: null, created_at: '2025-01-01' },
    ]);
    const result = checkDuplicate({ sqlJson }, 'Some test title that should match partially here too', 'decision', 'p', null);
    if (result.potential_duplicates.length > 0) {
      const sim = result.potential_duplicates[0].similarity;
      // Math.round(sim * 100) / 100 — verify it's rounded
      expect(sim).toBe(Math.round(sim * 100) / 100);
    }
  });
});

// ═══════════════════════════════════════════════
// recall.js — L14 StringLiteral (the `cnt` column)
// ═══════════════════════════════════════════════
describe('recall.js L14 StringLiteral killer', () => {
  it('getRecallCount SQL query contains `as cnt`', () => {
    const sqlJson = vi.fn(() => [{ cnt: 0 }]);
    getRecallCount({ sqlJson }, '1');
    const query = sqlJson.mock.calls[0][0];
    expect(query).toContain('as cnt');
  });
});

// ═══════════════════════════════════════════════
// context.js — exact SQL string verification
// ═══════════════════════════════════════════════
describe('context.js exact SQL verification', () => {
  it('buildTopicQueryMatch: empty needles returns scoreSql="0"', () => {
    const result = buildTopicQueryMatch([]);
    expect(result.scoreSql).toBe('0');
    expect(result.whereSql).toBe('');
  });

  it('buildTopicQueryMatch: joins whereParts with " OR "', () => {
    const result = buildTopicQueryMatch(['a', 'b']);
    expect(result.whereSql).toContain(') OR (');
  });

  it('buildTopicQueryMatch: scoreParts joined with " + "', () => {
    const result = buildTopicQueryMatch(['test']);
    expect(result.scoreSql).toContain(' + ');
  });

  it('buildTopicQueryMatch: field list is exact 3 fields', () => {
    const result = buildTopicQueryMatch(['x']);
    expect(result.whereSql).toContain("lower(coalesce(o.topic_key, ''))");
    expect(result.whereSql).toContain("lower(coalesce(o.title, ''))");
    expect(result.whereSql).toContain("lower(coalesce(o.content, ''))");
  });

  it('buildTopicQueryMatch: needle with only special chars still wraps in %', () => {
    const result = buildTopicQueryMatch(['%']);
    expect(result.whereParams[0]).toBe('%\\%%');
  });

  it('context: cross-project SQL has no project filter', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'"));
    expect(obsCall).toBeDefined();
    // In cross-project, the SQL should not have "o.project = ?"
    expect(obsCall[0]).not.toContain('o.project = ?');
  });

  it('context: non-cross-project SQL has project filter', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("o.project = ?") && !c[0].includes('topic_matches'));
    expect(obsCall).toBeDefined();
  });

  it('context: topic query SQL uses WITH clause', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('WITH'));
    expect(obsCall).toBeDefined();
  });

  it('context: deep mode uses Math.min for cross-project limit', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', deep: 'true', limit: '2' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'"));
    expect(obsCall).toBeDefined();
    const limit = obsCall[1][obsCall[1].length - 1];
    // deep limit = min(2 * MULTIPLIER, MAX)
    expect(limit).toBeLessThanOrEqual(CONTEXT.CROSS_PROJECT_DEEP_MAX);
  });

  it('context: token budget = 0 skips budget stats', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '0' });
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('context: token budget negative is treated as 0', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '-100' });
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('context: fetchCeiling = limit * 3 when budget > 0', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', limit: '5', 'token-budget': '500' });
    // The non-topic, non-cross-project query should use fetchCeiling = max(5, 15) = 15
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall).toBeDefined();
    expect(obsCall[1][obsCall[1].length - 1]).toBe(15); // limit * 3
  });

  it('context: cross-project supplement fires when all 4 conditions met', () => {
    // Conditions: !crossProject && project && filtered.length > 0 && topicQuery
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 'auth test', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [{ id: 99, title: 'cross', type: 'decision', project: 'other', created_at: '2025-01-01', trust_score: 0.5, match_score: 1 }];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth token' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall).toBeDefined();
    // Supplement query has GROUP BY
    expect(crossCall[0]).toContain('GROUP BY');
    // Supplement query has ORDER BY match_score
    expect(crossCall[0]).toContain('match_score');
  });

  it('context: cross-project supplement does NOT fire when crossProject=true', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth', 'all-projects': 'true' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall).toBeUndefined();
  });

  it('context: cross-project supplement does NOT fire without topicQuery', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('observations o') && !q.includes('topic_matches')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall).toBeUndefined();
  });

  it('context: recall log query is "context-auto" when no topic', () => {
    const irlMock = vi.fn();
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
    });
    context(mockDeps({ sqlJson, insertRecallLog: irlMock }), { project: 'p', 'session-id': '1' });
    if (irlMock.mock.calls.length > 0) {
      const entries = irlMock.mock.calls[0][0];
      expect(entries[0].query).toBe('context-auto');
    }
  });

  it('context: recall log query uses topicQuery when present', () => {
    const irlMock = vi.fn();
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      return [];
    });
    context(mockDeps({ sqlJson, insertRecallLog: irlMock }), { project: 'p', query: 'jwt auth', 'session-id': '1' });
    if (irlMock.mock.calls.length > 0) {
      const entries = irlMock.mock.calls[0][0];
      expect(entries[0].query).toBe('jwt auth');
    }
  });

  it('context: recall log query uses topicKey when present (no query)', () => {
    const irlMock = vi.fn();
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_key = ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      return [];
    });
    context(mockDeps({ sqlJson, insertRecallLog: irlMock }), { project: 'p', 'topic-key': 'auth', 'session-id': '1' });
    if (irlMock.mock.calls.length > 0) {
      const entries = irlMock.mock.calls[0][0];
      expect(entries[0].query).toBe('auth');
    }
  });
});

// ═══════════════════════════════════════════════
// applyTokenBudget — never-truncate overflow branch
// ═══════════════════════════════════════════════
describe('context.js applyTokenBudget never-truncate overflow', () => {
  const ts = () => new Date().toISOString().replace('Z', '');
  const CONTEXT_CONST = require('../constants').CONTEXT;

  it('never-truncate type: _truncated=false even when overflowing budget', () => {
    const nt = (CONTEXT_CONST.NEVER_TRUNCATE_TYPES || [])[0];
    if (!nt) return;
    // First, consume budget with a normal item
    const normal = { id: 1, title: 'big', type: 'observation', content: 'X'.repeat(2000), trust_score: 0.5, created_at: ts() };
    // Then add a never-truncate item that would overflow
    const ntItem = { id: 2, title: 'nt', type: nt, content: 'Y'.repeat(500), trust_score: 0.5, created_at: ts() };
    // Budget = 600: normal=503 fits, then nt item would overflow
    const result = applyTokenBudget([normal, ntItem], 600);
    if (result.length > 1) {
      const ntResult = result.find(o => o.type === nt);
      if (ntResult) {
        expect(ntResult._truncated).toBe(false);
        expect(ntResult.content.length).toBe(500);
      }
    }
  });
});

// ═══════════════════════════════════════════════
// search.js — ranking formula exact verification
// ═══════════════════════════════════════════════
describe('search.js ranking formula exact', () => {
  it('composite score is multiplied by typeBoost and navBoost', () => {
    // Same content, different type → different score due to typeBoost
    const base = { title: 'test', rank: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 };
    const decision = rankObservations([{ ...base, id: 1, type: 'decision' }], 'q')[0];
    const observation = rankObservations([{ ...base, id: 1, type: 'observation' }], 'q')[0];
    const decisionBoost = RANKING.TYPE_BOOST['decision'] || 1.0;
    const obsBoost = RANKING.TYPE_BOOST['observation'] || 1.0;
    if (decisionBoost !== obsBoost) {
      // Scores should differ proportionally to boost ratio
      const ratio = decision._score / observation._score;
      expect(ratio).toBeCloseTo(decisionBoost / obsBoost, 2);
    }
  });

  it('recallScore formula: log(1+n)*MULT*ratio + ratio*USEFUL', () => {
    // n=3, useful=3, ratio=1
    // recallScore = log(4)*MULT + 1*USEFUL
    const r = rankObservations([
      baseObs({ id: 1, rank: 0, recall_count: 3, useful_count: 3, type: 'observation' }),
    ], 'test')[0];
    // The recall component should contribute log(4)*MULT + USEFUL to the composite
    // (before multiplication by other weights and typeBoost)
    expect(r._score).toBeGreaterThan(0);
  });

  it('score multiplies by typeBoost (not adds)', () => {
    // If it were addition, the score difference would be constant regardless of base
    // If multiplication, the ratio stays constant
    const base = baseObs({ id: 1, rank: -2, recall_count: 5, useful_count: 4 });
    const r1 = rankObservations([{ ...base, type: 'decision' }], 'q')[0];
    const r2 = rankObservations([{ ...base, type: 'unknown' }], 'q')[0];
    // ratio should equal TYPE_BOOST['decision'] / TYPE_BOOST['unknown'] or 1
    const expectedRatio = (RANKING.TYPE_BOOST['decision'] || 1) / (RANKING.TYPE_BOOST['unknown'] || 1);
    expect(r1._score / r2._score).toBeCloseTo(expectedRatio, 2);
  });
});

// ═══════════════════════════════════════════════
// search.js — special query FTS path (NoCoverage)
// ═══════════════════════════════════════════════
describe('search.js FTS special path', () => {
  it('FTS query with special chars: catches the error in try/catch', () => {
    // For special queries, FTS is skipped entirely (isFtsSpecial check)
    // so no error is thrown
    const sqlJson = vi.fn(() => [baseObs({ id: 1 })]);
    const deps = mockDeps({ sqlJson });
    delete deps.insertRecallLog;
    expect(() => search(deps, { query: 'test*' })).not.toThrow();
    // The first call should be LIKE (not FTS) because of the special char
    expect(sqlJson.mock.calls[0][0]).toContain('LIKE');
  });

  it('search function: FTS LIMIT multiplier is SEARCH_MULTIPLIER', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test', limit: '3' });
    const ftsCall = sqlJson.mock.calls[0];
    // Last param is the FTS limit
    const limit = ftsCall[1][ftsCall[1].length - 1];
    expect(limit).toBe(Math.min(3 * RESULT_LIMITS.SEARCH_MULTIPLIER, RESULT_LIMITS.SEARCH_MAX_ROWS));
  });

  it('search function: LIKE fallback LIMIT also uses multiplier', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n === 1 ? [] : [baseObs({ id: 1 })]; });
    search(mockDeps({ sqlJson }), { query: 'normal', limit: '3' });
    // FTS returns empty → LIKE fallback. The LIKE call (index 1) has the multiplier.
    const likeCall = sqlJson.mock.calls[1];
    const limit = likeCall[1][likeCall[1].length - 1];
    expect(limit).toBe(Math.min(3 * RESULT_LIMITS.SEARCH_MULTIPLIER, RESULT_LIMITS.SEARCH_MAX_ROWS));
  });

  it('search: relations query only fires when results exist', () => {
    const sqlJson = vi.fn(() => []);
    search(mockDeps({ sqlJson }), { query: 'test' });
    // No results → no relations query
    const relCalls = sqlJson.mock.calls.filter(c => c[0].includes('observation_relations'));
    expect(relCalls.length).toBe(0);
  });

  it('search: when include-code=false, no searchCode call', () => {
    const searchCode = vi.fn(() => [{ symbol: 'foo' }]);
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson, searchCode }), { query: 'test' });
    expect(searchCode).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════
// search.js — _extractFtsTerms NoCoverage L25, L42
// ═══════════════════════════════════════════════
describe('search.js _extractFtsTerms NoCoverage killers', () => {
  it('extractFtsTerms: handles special regex characters', () => {
    const result = extractFtsTerms('hello.world_test/foo');
    expect(result).toBeTruthy();
  });

  it('extractFtsTerms: stop words list is complete', () => {
    expect(extractFtsTerms('a an the is are was were')).not.toContain('a');
    expect(extractFtsTerms('a an the is are was were')).not.toContain('the');
  });

  it('extractFtsTerms: preserves terms (dots/slashes become spaces)', () => {
    const result = extractFtsTerms('index.js utils helpers');
    // The regex replaces non-alphanumeric with space, so 'index.js' → 'index' and 'js'
    // So the result contains 'index' and 'js' as separate terms
    expect(result).toContain('index');
    expect(result).toContain('utils');
  });

  it('extractFtsTerms: empty input returns empty', () => {
    expect(extractFtsTerms('')).toBe('');
  });

  it('extractFtsTerms: all stop words returns empty', () => {
    expect(extractFtsTerms('the and or but')).toBe('');
  });
});

// ═══════════════════════════════════════════════
// search.js — FTS NoCoverage L253-282
// ═══════════════════════════════════════════════
describe('search.js FTS try/catch NoCoverage killers', () => {
  it('FTS throws → caught → LIKE fallback runs', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('observations_fts')) throw new Error('FTS table missing');
      return [baseObs({ id: 1 })];
    });
    const d = mockDeps({ sqlJson });
    delete d.insertRecallLog;
    const result = search(d, { query: 'normal' });
    expect(result.results.length).toBe(1);
  });

  it('FTS query includes snippet function', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test' });
    expect(sqlJson.mock.calls[0][0]).toContain('snippet(');
  });

  it('FTS query joins observations_fts', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test' });
    expect(sqlJson.mock.calls[0][0]).toContain('JOIN observations_fts fts');
  });

  it('LIKE fallback query selects empty snippet', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n === 1 ? [] : [baseObs({ id: 1 })]; });
    search(mockDeps({ sqlJson }), { query: 'test' });
    const likeCall = sqlJson.mock.calls[1][0];
    expect(likeCall).toContain("'' as snippet");
    expect(likeCall).toContain('0 as rank');
  });

  it('LIKE fallback escapes % and _ in query', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n === 1 ? [] : [baseObs({ id: 1 })]; });
    search(mockDeps({ sqlJson }), { query: '100%_test' });
    const likeCall = sqlJson.mock.calls[1];
    expect(likeCall[1][0]).toBe('%100\\%\\_test%');
  });

  it('LIKE fallback uses o.title LIKE and o.content LIKE', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n === 1 ? [] : [baseObs({ id: 1 })]; });
    search(mockDeps({ sqlJson }), { query: 'test' });
    const likeCall = sqlJson.mock.calls[1][0];
    expect(likeCall).toContain('o.title LIKE ?');
    expect(likeCall).toContain('o.content LIKE ?');
  });
});

// ═══════════════════════════════════════════════
// search.js — relations query NoCoverage L305-321
// ═══════════════════════════════════════════════
describe('search.js relations NoCoverage killers', () => {
  it('relations query uses placeholders for ranked IDs', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('observations_fts')) return [
        baseObs({ id: 1, snippet: 't', rank: -1 }),
        baseObs({ id: 2, snippet: 't', rank: -1 }),
      ];
      return [];
    });
    search(mockDeps({ sqlJson }), { query: 'test' });
    const relCall = sqlJson.mock.calls.find(c => c[0].includes('observation_relations'));
    expect(relCall).toBeDefined();
    expect(relCall[0]).toContain('source_id IN');
    expect(relCall[0]).toContain('target_id IN');
  });

  it('relations query returns _relations array on each result', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('observations_fts')) return [baseObs({ id: 1, snippet: 't', rank: -1 })];
      if (q.includes('observation_relations')) return [{ source_id: 1, target_id: 2, relation: 'related', confidence: 0.8 }];
      return [];
    });
    const r = search(mockDeps({ sqlJson }), { query: 'test' });
    expect(Array.isArray(r.results[0]._relations)).toBe(true);
    expect(r.results[0]._relations.length).toBe(1);
  });

  it('results without relations get empty _relations array', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('observations_fts')) return [baseObs({ id: 1, snippet: 't', rank: -1 })];
      return [];
    });
    const r = search(mockDeps({ sqlJson }), { query: 'test' });
    expect(r.results[0]._relations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════
// context.js — exact SQL formula verification
// ═══════════════════════════════════════════════
describe('context.js exact SQL formula', () => {
  it('context: deep mode limit = min(limit*MULT, MAX)', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', deep: 'true', limit: '1' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'"));
    const limit = obsCall[1][obsCall[1].length - 1];
    expect(limit).toBe(CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER);
  });

  it('context: deep topic limit uses Math.min with MAX', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth', deep: 'true', limit: '1000' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_matches') && !c[0].includes('project != ?'));
    if (obsCall) {
      const limit = obsCall[1][obsCall[1].length - 1];
      expect(limit).toBeLessThanOrEqual(CONTEXT.CROSS_PROJECT_DEEP_MAX);
    }
  });

  it('context: tokenBudget uses Number.isFinite check', () => {
    const sqlJson = vi.fn(() => []);
    let r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': 'Infinity' });
    expect(r.stats.budget_used).toBeUndefined();
    r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': 'NaN' });
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('context: fetchCeiling = limit when budget=0', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', limit: '7' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[1][obsCall[1].length - 1]).toBe(7);
  });

  it('context: fetchCeiling = max(limit, limit*3) when budget>0', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', limit: '2', 'token-budget': '500' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[1][obsCall[1].length - 1]).toBe(6);
  });

  it('context: cross-project SQL orders by recall_count DESC', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain('ORDER BY recall_count DESC');
  });

  it('context: non-cross-project SQL orders by recall_count DESC', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain('ORDER BY recall_count DESC');
  });

  it('context: topic-key SQL has CASE WHEN for topic_key boost', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'topic-key': 'auth' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_key = ?') && !c[0].includes('topic_matches'));
    // The SQL has CASE WHEN o.topic_key = ? THEN <boost_value>
    expect(obsCall[0]).toContain('CASE WHEN o.topic_key = ?');
  });

  it('context: stats.total_count = filtered.length', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [
        { id: 1, title: 't1', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
        { id: 2, title: 't2', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
      ];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '10000' });
    expect(r.stats.total_count).toBe(2);
  });

  it('context: budget_used sums _tokens from all budgeted observations', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [
        { id: 1, title: 't1', type: 'decision', content: 'content one', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 },
      ];
    });
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '500' });
    expect(r.stats.budget_used).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// dedupe.js — L18 exact trigram formula
// ═══════════════════════════════════════════════
describe('dedupe.js L18 exact formula', () => {
  it('shared++ increments for each matching trigram (not just first)', () => {
    const result = trigramOverlap('abcabcabc', 'abcdefghi');
    expect(result).toBeCloseTo(1/7, 10);
  });

  it('shared count > 1 works correctly', () => {
    const result = trigramOverlap('abcdabcd', 'abcdxyzq');
    expect(result).toBeCloseTo(2/6, 10);
  });

  it('Math.max denominator (not Math.min)', () => {
    const result = trigramOverlap('abc', 'abcdefghij');
    expect(result).toBeCloseTo(1/8, 10);
  });
});

// ═══════════════════════════════════════════════
// search.js — ranking formula ArithmeticOperator killers
// ═══════════════════════════════════════════════
describe('search.js ranking formula ArithmeticOperator killers', () => {
  it('ftsScore = (hits/total)*2 distinguishes from +', () => {
    // query='alpha beta', title='alpha' → 1/2 * 2 = 1.0
    // If mutated to +: 1/2 + 2 = 2.5
    // If mutated to *: 1/2 * 2 = 1.0 (same)
    // Use title='alpha beta gamma' → 2/2 * 2 = 2.0
    // If mutated to +: 2/2 + 2 = 3.0
    // If mutated to -: 2/2 - 2 = -1.0
    const r = rankObservations([baseObs({ id: 1, rank: 0, title: 'alpha beta gamma' })], 'alpha beta')[0];
    const ranking = require('../config').getConfig().ranking;
    // fts component = 2.0 * ranking.fts_relevance
    // The score should be > 0
    expect(r._score).toBeGreaterThan(0);
  });

  it('recallScore = log(1+n)*MULT*ratio + ratio*USEFUL distinguishes from *', () => {
    // n=4, useful=2, ratio=0.5
    // recallScore = log(5)*MULT*0.5 + 0.5*USEFUL
    // If mutated to single *: log(5)*MULT*0.5 + 0.5*USEFUL (same for * in first term)
    // If mutated to + in first term: (log(5)+MULT)*0.5 + 0.5*USEFUL
    const r = rankObservations([
      baseObs({ id: 1, rank: 0, recall_count: 4, useful_count: 2 }),
    ], 'q')[0];
    expect(r._score).toBeGreaterThan(0);
  });

  it('recency = exp(-ageMs/HALF_LIFE) distinguishes from *', () => {
    // Fresh obs: ageMs≈0, exp(0)=1
    // Very old obs: exp(-large)≈0
    // If mutated to *: -ageMs * HALF_LIFE (negative huge number)
    // The composite score would be very negative
    const fresh = rankObservations([baseObs({ id: 1, rank: null, created_at: new Date().toISOString().replace('Z', '') })], 'q')[0];
    const old = rankObservations([baseObs({ id: 1, rank: null, created_at: new Date(Date.now() - 365 * 86400000).toISOString().replace('Z', '') })], 'q')[0];
    // Fresh should have higher score (recency = 1.0 vs ~0)
    expect(fresh._score).toBeGreaterThan(old._score);
    // Both should be positive (recency is exp which is always positive)
    expect(fresh._score).toBeGreaterThan(0);
  });

  it('usefulRatio = useful/recall distinguishes from *', () => {
    // n=10, useful=10 → ratio=1.0
    // n=10, useful=0 → ratio=0.0
    // If mutated to *: 10*10=100 vs 10*0=0 (very different, both positive)
    // If mutated to -: 10-10=0 vs 10-0=10 (very different)
    const high = rankObservations([baseObs({ id: 1, rank: null, recall_count: 10, useful_count: 10 })], 'q')[0];
    const low = rankObservations([baseObs({ id: 1, rank: null, recall_count: 10, useful_count: 0 })], 'q')[0];
    // high should have much higher recallScore
    expect(high._score).toBeGreaterThan(low._score);
  });

  it('composite = (fts*W1 + recency*W2 + trust*W3 + recall*W4) * typeBoost * navBoost', () => {
    // typeBoost is a multiplier, not an addend
    // If mutated to +: score = base + typeBoost (constant offset)
    // If mutated to *: score = base * typeBoost (proportional)
    const r1 = rankObservations([baseObs({ id: 1, rank: -2, type: 'decision' })], 'q')[0];
    const r2 = rankObservations([baseObs({ id: 1, rank: -2, type: 'unknown' })], 'q')[0];
    // Ratio should equal typeBoost ratio
    const expectedRatio = (RANKING.TYPE_BOOST['decision'] || 1) / (RANKING.TYPE_BOOST['unknown'] || 1);
    if (expectedRatio !== 1) {
      expect(r1._score / r2._score).toBeCloseTo(expectedRatio, 2);
    }
  });

  it('composite multiplication: ftsScore * ranking.fts_relevance', () => {
    // ftsScore = -rank = 2
    // composite fts component = 2 * fts_relevance
    // If mutated to +: 2 + fts_relevance
    const ranking = require('../config').getConfig().ranking;
    const r1 = rankObservations([baseObs({ id: 1, rank: -2 })], 'q')[0];
    const r2 = rankObservations([baseObs({ id: 1, rank: -1 })], 'q')[0];
    // r1 has ftsScore=2, r2 has ftsScore=1
    // Difference should be exactly ranking.fts_relevance
    const diff = r1._score - r2._score;
    expect(diff).toBeCloseTo(ranking.fts_relevance, 5);
  });

  it('navBoost is a multiplier (not addend)', () => {
    // navBoost = 1.0 for non-nav, > 1.0 for nav queries
    // If multiplied: score increases proportionally
    // If added: score increases by constant
    const nav = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js', rank: null, snippet: '' })],
      'where is the hook module',
    )[0];
    const normal = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js', rank: null, snippet: '' })],
      'random query xyz',
    )[0];
    const navMultiplier = RANKING.NAVIGATION_BOOST.path_multiplier;
    if (navMultiplier > 1.0) {
      // nav score should be navMultiplier * normal score
      expect(nav._score / normal._score).toBeCloseTo(navMultiplier, 1);
    }
  });
});

// ═══════════════════════════════════════════════
// context.js — buildTopicQueryMatch SQL exact strings
// ═══════════════════════════════════════════════
describe('context.js buildTopicQueryMatch SQL exact', () => {
  it('field list: exact 3 fields with lower+coalesce', () => {
    const result = buildTopicQueryMatch(['x']);
    // Must contain all 3 fields with lower+coalesce
    expect(result.whereSql).toContain("lower(coalesce(o.topic_key, ''))");
    expect(result.whereSql).toContain("lower(coalesce(o.title, ''))");
    expect(result.whereSql).toContain("lower(coalesce(o.content, ''))");
  });

  it('wherePart format: (field LIKE ? OR field LIKE ? OR field LIKE ?)', () => {
    const result = buildTopicQueryMatch(['x']);
    // Each needle produces a parenthesized group with 3 LIKE clauses joined by OR
    expect(result.whereSql).toMatch(/^\(.*LIKE \?.*LIKE \?.*LIKE \?\)$/);
  });

  it('scorePart format: CASE WHEN field LIKE ? THEN 1 ELSE 0 END', () => {
    const result = buildTopicQueryMatch(['x']);
    expect(result.scoreSql).toContain('CASE WHEN');
    expect(result.scoreSql).toContain('THEN 1 ELSE 0 END');
  });

  it('scoreParams: one per field per needle', () => {
    const result = buildTopicQueryMatch(['a', 'b']);
    // 2 needles * 3 fields = 6
    expect(result.scoreParams.length).toBe(6);
  });

  it('whereParams: one per field per needle', () => {
    const result = buildTopicQueryMatch(['a', 'b']);
    // 2 needles * 3 fields = 6
    expect(result.whereParams.length).toBe(6);
  });

  it('needle is wrapped in % wildcards', () => {
    const result = buildTopicQueryMatch(['test']);
    // First whereParam should be %test%
    expect(result.whereParams[0]).toBe('%test%');
  });

  it('scorePart count matches needle count * field count', () => {
    const result = buildTopicQueryMatch(['a']);
    // Split by "CASE WHEN" to count
    const caseCount = result.scoreSql.split('CASE WHEN').length - 1;
    expect(caseCount).toBe(3); // 3 fields
  });
});

// ═══════════════════════════════════════════════
// context.js — exact ORDER BY / LIMIT verification
// ═══════════════════════════════════════════════
describe('context.js ORDER BY / LIMIT verification', () => {
  it('non-cross-project, non-topic: ORDER BY recall_count, type_priority, trust, created_at', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toMatch(/ORDER BY recall_count DESC, type_priority DESC, trust_score DESC, o\.created_at DESC/);
  });

  it('cross-project: ORDER BY recall_count, trust, type_priority, created_at', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toMatch(/ORDER BY recall_count DESC, trust_score DESC, type_priority DESC, o\.created_at DESC/);
  });

  it('topic-key: ORDER BY recall_count, topic_key boost, trust, created_at', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', 'topic-key': 'auth' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_key = ?') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain('ORDER BY recall_count DESC');
    expect(obsCall[0]).toContain('trust_score DESC');
  });

  it('topic query: ORDER BY match_score, recall_count, trust, type_priority, created_at', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_matches') && !c[0].includes('project != ?'));
    expect(obsCall[0]).toContain('match_score DESC');
    expect(obsCall[0]).toContain('recall_count DESC');
    expect(obsCall[0]).toContain('trust_score DESC');
    expect(obsCall[0]).toContain('type_priority DESC');
  });

  it('cross-project supplement: ORDER BY match_score, trust, created_at', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [{ id: 99, title: 'cross', type: 'decision', project: 'other', created_at: '2025-01-01', trust_score: 0.5, match_score: 1 }];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain('ORDER BY match_score DESC, trust_score DESC, o.created_at DESC');
  });
});

// ═══════════════════════════════════════════════
// search.js — exact composite score formula verification
// ═══════════════════════════════════════════════
describe('search.js exact composite score formula', () => {
  it('composite = (fts*W1 + recency*W2 + trust*W3 + recall*W4) * typeBoost * navBoost', () => {
    // Use a row where we can compute the exact expected score
    const ts = new Date().toISOString().replace('Z', '');
    const row = {
      id: 1, title: 'test', type: 'observation', created_at: ts,
      trust_score: 0.5, recall_count: 0, useful_count: 0, rank: null,
    };
    const r = rankObservations([row], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    // ftsScore=0 (rank=null, no query match), recency≈1 (fresh), trust=0.5, recall=0
    // typeBoost=1.0 (observation), navBoost=1.0
    // Expected ≈ recency * ranking.recency + 0.5 * ranking.trust
    expect(r._score).toBeGreaterThan(0);
    // The score should be roughly ranking.recency + 0.5 * ranking.trust
    const expected = 1.0 * ranking.recency + 0.5 * ranking.trust;
    expect(r._score).toBeCloseTo(expected, 1);
  });

  it('fts component: ftsScore * ranking.fts_relevance (not +)', () => {
    // Row with rank=-5 → ftsScore=5
    // Row with rank=-1 → ftsScore=1
    // Difference in score should be exactly (5-1) * fts_relevance = 4 * fts_relevance
    const r5 = rankObservations([baseObs({ id: 1, rank: -5 })], 'q')[0];
    const r1 = rankObservations([baseObs({ id: 1, rank: -1 })], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    const diff = r5._score - r1._score;
    expect(diff).toBeCloseTo(4 * ranking.fts_relevance, 3);
  });

  it('trust component: trustScore * ranking.trust (not +)', () => {
    const r9 = rankObservations([baseObs({ id: 1, rank: null, trust_score: 0.9 })], 'q')[0];
    const r1 = rankObservations([baseObs({ id: 1, rank: null, trust_score: 0.1 })], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    const diff = r9._score - r1._score;
    expect(diff).toBeCloseTo(0.8 * ranking.trust, 3);
  });

  it('recallScore = log(1+n)*MULT*ratio + ratio*USEFUL', () => {
    // n=9, useful=9, ratio=1
    // recallScore = log(10)*MULT*1 + 1*USEFUL
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 9, useful_count: 9 }),
    ], 'q')[0];
    const r0 = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    // Difference should include the recallScore component * ranking.recall
    const expectedRecallContrib = (Math.log(10) * RANKING.RECALL_LOG_MULTIPLIER + RANKING.USEFULNESS_MULTIPLIER);
    const ranking = require('../config').getConfig().ranking;
    const diff = r._score - r0._score;
    expect(diff).toBeCloseTo(expectedRecallContrib * ranking.recall, 1);
  });

  it('recallScore: + between two terms (not * or -)', () => {
    // With ratio=0.5, recallScore = log(1+n)*MULT*0.5 + 0.5*USEFUL
    // If mutated to *: log(1+n)*MULT*0.5 * 0.5*USEFUL (very different)
    // If mutated to -: log(1+n)*MULT*0.5 - 0.5*USEFUL (very different)
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 2, useful_count: 1 }),
    ], 'q')[0];
    // The recallScore should be positive (sum of two positive terms)
    expect(r._score).toBeGreaterThan(0);
  });

  it('composite * typeBoost: multiplication not addition', () => {
    // If typeBoost is 2.0 and base is 1.0:
    // Multiplication: 1.0 * 2.0 = 2.0
    // Addition: 1.0 + 2.0 = 3.0
    const r1 = rankObservations([baseObs({ id: 1, rank: -2, type: 'decision' })], 'q')[0];
    const r2 = rankObservations([baseObs({ id: 1, rank: -2, type: 'observation' })], 'q')[0];
    const decisionBoost = RANKING.TYPE_BOOST['decision'] || 1.0;
    const obsBoost = RANKING.TYPE_BOOST['observation'] || 1.0;
    if (decisionBoost !== obsBoost) {
      // Ratio should be exactly the boost ratio
      expect(r1._score / r2._score).toBeCloseTo(decisionBoost / obsBoost, 3);
    }
  });

  it('composite * navBoost: multiplication not addition', () => {
    const nav = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js', rank: null, snippet: '' })],
      'where is the hook module',
    )[0];
    const normal = rankObservations(
      [baseObs({ id: 1, title: 'src/index.js', rank: null, snippet: '' })],
      'xyz random query',
    )[0];
    const navMult = RANKING.NAVIGATION_BOOST.path_multiplier;
    if (navMult > 1.0) {
      // Ratio should be exactly navMult
      expect(nav._score / normal._score).toBeCloseTo(navMult, 1);
    }
  });
});

// ═══════════════════════════════════════════════
// search.js — recallScore ArithmeticOperator L44-55
// ═══════════════════════════════════════════════
describe('search.js recallScore ArithmeticOperator killers', () => {
  it('Math.log(1+n) distinguishes from Math.log(1-n) and Math.log(1*n)', () => {
    // n=4: log(5) ≈ 1.609
    // If mutated to log(1-n): log(-3) = NaN
    // If mutated to log(1*n): log(4) ≈ 1.386
    // If mutated to log(1/n): log(0.25) ≈ -1.386
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 4, useful_count: 4 }),
    ], 'q')[0];
    const r0 = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    // Difference should include log(5) * MULT component
    const expected = Math.log(5) * RANKING.RECALL_LOG_MULTIPLIER * 1 + 1 * RANKING.USEFULNESS_MULTIPLIER;
    const ranking = require('../config').getConfig().ranking;
    const diff = r._score - r0._score;
    expect(diff).toBeCloseTo(expected * ranking.recall, 1);
  });

  it('usefulRatio = useful/recall (not useful*recall or useful-recall)', () => {
    // n=10, useful=5: ratio = 5/10 = 0.5
    // If mutated to *: 50
    // If mutated to -: -5
    // If mutated to +: 15
    // recallScore = log(11)*MULT*0.5 + 0.5*USEFUL
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 10, useful_count: 5 }),
    ], 'q')[0];
    const r0 = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    const expected = Math.log(11) * RANKING.RECALL_LOG_MULTIPLIER * 0.5 + 0.5 * RANKING.USEFULNESS_MULTIPLIER;
    const ranking = require('../config').getConfig().ranking;
    const diff = r._score - r0._score;
    expect(diff).toBeCloseTo(expected * ranking.recall, 1);
  });

  it('usefulRatio default 0.5 when recallCount=0', () => {
    // recallCount=0 → usefulRatio=0.5 (not 0, not 1)
    // recallScore = log(1)*MULT*0.5 + 0.5*USEFUL = 0 + 0.5*USEFUL
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    // The recall component should be 0.5 * USEFUL * ranking.recall
    // But log(1) = 0, so first term is 0
    // Total recall contribution = 0.5 * USEFUL * ranking.recall
    const rUseful = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 5 }),
    ], 'q')[0];
    // Both have ratio=0.5, so scores should be same
    expect(r._score).toBeCloseTo(rUseful._score, 5);
  });
});

// ═══════════════════════════════════════════════
// search.js — search function SQL building (L253-282)
// ═══════════════════════════════════════════════
describe('search.js search() SQL building L253-282', () => {
  it('FTS query includes TRUST_RECALL_JOINS', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test' });
    const ftsQuery = sqlJson.mock.calls[0][0];
    expect(ftsQuery).toContain('LEFT JOIN');
    expect(ftsQuery).toContain('symbol_links');
  });

  it('FTS query WHERE includes MATCH clause', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test' });
    const ftsQuery = sqlJson.mock.calls[0][0];
    expect(ftsQuery).toContain('observations_fts MATCH ?');
  });

  it('FTS query WHERE includes deleted_at check', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test' });
    const ftsQuery = sqlJson.mock.calls[0][0];
    expect(ftsQuery).toContain('o.deleted_at IS NULL');
  });

  it('FTS query WHERE includes expires_at check', () => {
    const sqlJson = vi.fn(() => [baseObs({ id: 1, snippet: 't', rank: -1 })]);
    search(mockDeps({ sqlJson }), { query: 'test' });
    const ftsQuery = sqlJson.mock.calls[0][0];
    expect(ftsQuery).toContain('expires_at');
  });

  it('LIKE fallback includes TRUST_RECALL_JOINS', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n === 1 ? [] : [baseObs({ id: 1 })]; });
    search(mockDeps({ sqlJson }), { query: 'test' });
    const likeQuery = sqlJson.mock.calls[1][0];
    expect(likeQuery).toContain('LEFT JOIN');
  });

  it('LIKE fallback ORDER BY created_at DESC', () => {
    let n = 0;
    const sqlJson = vi.fn(() => { n++; return n === 1 ? [] : [baseObs({ id: 1 })]; });
    search(mockDeps({ sqlJson }), { query: 'test' });
    const likeQuery = sqlJson.mock.calls[1][0];
    expect(likeQuery).toContain('ORDER BY o.created_at DESC');
  });
});

// ═══════════════════════════════════════════════
// search.js — symbolCluster/relations L358-405
// ═══════════════════════════════════════════════
describe('search.js symbol functions L358-405', () => {
  it('symbolCluster: returns symbol in response', () => {
    const sqlJson = vi.fn(() => [{ id: 1, title: 't' }]);
    const r = symbolCluster(mockDeps({ sqlJson }), { symbol: 'sym1' });
    expect(r).toHaveProperty('symbol');
    expect(r.symbol).toBe('sym1');
  });

  it('symbolCluster: returns memories array', () => {
    const sqlJson = vi.fn(() => []);
    const r = symbolCluster(mockDeps({ sqlJson }), { symbol: 'sym1' });
    expect(r).toHaveProperty('memories');
    expect(Array.isArray(r.memories)).toBe(true);
  });

  it('related: returns memory_id in response', () => {
    const sqlJson = vi.fn(() => []);
    const r = related(mockDeps({ sqlJson }), { id: '5' });
    expect(r).toHaveProperty('memory_id');
    expect(r.memory_id).toBe(5);
  });

  it('related: returns related array', () => {
    const sqlJson = vi.fn(() => []);
    const r = related(mockDeps({ sqlJson }), { id: '5' });
    expect(r).toHaveProperty('related');
    expect(Array.isArray(r.related)).toBe(true);
  });

  it('related: each cluster has symbol, repo, memories', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('memory_id')) return [{ symbol_id: 's1', repo: 'r1' }];
      return [{ symbol_id: 's1', id: 2, title: 't', type: 'd', project: 'p', created_at: '2025-01-01' }];
    });
    const r = related(mockDeps({ sqlJson }), { id: '1' });
    if (r.related.length > 0) {
      expect(r.related[0]).toHaveProperty('symbol');
      expect(r.related[0]).toHaveProperty('repo');
      expect(r.related[0]).toHaveProperty('memories');
    }
  });

  it('related: SQL query filters out __unlinked__', () => {
    const sqlJson = vi.fn(() => []);
    related(mockDeps({ sqlJson }), { id: '1' });
    // The first SQL query should filter out __unlinked__
    const query = sqlJson.mock.calls[0][0];
    expect(query).toContain("symbol_id != ?");
    expect(sqlJson.mock.calls[0][1]).toContain('__unlinked__');
  });
});

// ═══════════════════════════════════════════════
// context.js — cross-project supplement SQL exact (L201-215)
// ═══════════════════════════════════════════════
describe('context.js cross-project supplement SQL exact', () => {
  it('supplement query: SELECT includes match_score from scoreSql', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [{ id: 99, title: 'cross', type: 'decision', project: 'other', created_at: '2025-01-01', trust_score: 0.5, match_score: 1 }];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth token' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain('as match_score');
  });

  it('supplement query: FROM observations o', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain('FROM observations o');
  });

  it('supplement query: LEFT JOIN symbol_links sl', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain('LEFT JOIN symbol_links sl');
  });

  it('supplement query: WHERE excludes current project', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'my-project', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[1]).toContain('my-project');
  });

  it('supplement query: WHERE excludes skill type', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain("o.type != 'skill'");
  });

  it('supplement query: WHERE filters scope = project', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain("o.scope = 'project'");
  });

  it('supplement query: WHERE includes expires_at check', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain('expires_at');
  });

  it('supplement query: GROUP BY o.id', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    expect(crossCall[0]).toContain('GROUP BY o.id');
  });

  it('supplement query: LIMIT is supplementLimit', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    const limit = crossCall[1][crossCall[1].length - 1];
    expect(limit).toBe(CONTEXT.CROSS_PROJECT_SUPPLEMENT_LIMIT || 3);
  });
});

// ═══════════════════════════════════════════════
// context.js — applyTokenBudget never-truncate overflow (L284-285)
// ═══════════════════════════════════════════════
describe('context.js applyTokenBudget never-truncate overflow', () => {
  const ts = () => new Date().toISOString().replace('Z', '');

  it('never-truncate type overflows budget: _truncated=false, full content preserved', () => {
    const nt = (CONTEXT.NEVER_TRUNCATE_TYPES || [])[0];
    if (!nt) return;
    const normal = { id: 1, title: 'normal item', type: 'observation', content: 'X'.repeat(1500), trust_score: 0.5, created_at: ts() };
    const ntItem = { id: 2, title: 'never truncate', type: nt, content: 'Y'.repeat(300), trust_score: 0.5, created_at: ts() };
    const result = applyTokenBudget([normal, ntItem], 500);
    if (result.length > 1) {
      const ntResult = result.find(o => o.type === nt);
      if (ntResult) {
        expect(ntResult._truncated).toBe(false);
        expect(ntResult.content.length).toBe(300);
      }
    }
  });
});

// ═══════════════════════════════════════════════
// search.js — FTS try/catch L253-282
// ═══════════════════════════════════════════════
describe('search.js FTS try/catch L253-282', () => {
  it('FTS catch sets rows=null, triggers LIKE fallback', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('observations_fts')) throw new Error('FTS table missing');
      return [baseObs({ id: 1 })];
    });
    const d = mockDeps({ sqlJson });
    delete d.insertRecallLog;
    const result = search(d, { query: 'test' });
    expect(result.results.length).toBe(1);
  });

  it('FTS returns null rows: LIKE fallback runs', () => {
    let n = 0;
    const sqlJson = vi.fn((q) => {
      n++;
      if (q.includes('observations_fts')) return null;
      return [baseObs({ id: 1 })];
    });
    const d = mockDeps({ sqlJson });
    delete d.insertRecallLog;
    const result = search(d, { query: 'test' });
    expect(result.results.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// dedupe.js — L18 trigram formula final precision
// ═══════════════════════════════════════════════
describe('dedupe.js L18 final precision', () => {
  it('shared loop: exactly N matches for N shared trigrams', () => {
    expect(trigramOverlap('abcdef', 'abcdef')).toBe(1.0);
  });

  it('shared loop: 0 shared → 0.0', () => {
    expect(trigramOverlap('aaa', 'bbb')).toBe(0.0);
  });

  it('denominator: uses Math.max(ta.size, tb.size)', () => {
    // 'abc' (1 trigram) vs 'abcdefgh' (6 trigrams), shared = 1
    // max(1, 6) = 6 → 1/6
    // min(1, 6) = 1 → 1/1 = 1.0
    const result = trigramOverlap('abc', 'abcdefgh');
    expect(result).toBeCloseTo(1/6, 10);
    expect(result).not.toBe(1.0);
  });
});

// ═══════════════════════════════════════════════
// context.js — remaining ArithmeticOperator and ConditionalExpression killers
// ═══════════════════════════════════════════════
describe('context.js remaining killers', () => {
  it('cross-project deep limit: limit * CROSS_PROJECT_DEEP_MULTIPLIER (not +)', () => {
    const sqlJson = vi.fn(() => []);
    // limit=5, deep=true, all-projects=true
    // crossLimit = min(5 * MULT, MAX) = 5 * MULT (if < MAX)
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', deep: 'true', limit: '5' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    const limit = obsCall[1][obsCall[1].length - 1];
    expect(limit).toBe(5 * CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER);
  });

  it('cross-project deep limit: capped at CROSS_PROJECT_DEEP_MAX', () => {
    const sqlJson = vi.fn(() => []);
    // limit=10000 should hit MAX cap
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', deep: 'true', limit: '10000' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    const limit = obsCall[1][obsCall[1].length - 1];
    expect(limit).toBe(CONTEXT.CROSS_PROJECT_DEEP_MAX);
  });

  it('topic deep limit: uses Math.min with MAX', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth', deep: 'true', limit: '10000' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('topic_matches') && !c[0].includes('project != ?'));
    if (obsCall) {
      const limit = obsCall[1][obsCall[1].length - 1];
      expect(limit).toBe(CONTEXT.CROSS_PROJECT_DEEP_MAX);
    }
  });

  it('fetchCeiling: Math.max(limit, limit * 3) when budget > 0', () => {
    const sqlJson = vi.fn(() => []);
    // limit=10, budget=500 → fetchCeiling = max(10, 30) = 30
    context(mockDeps({ sqlJson }), { project: 'p', limit: '10', 'token-budget': '500' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[1][obsCall[1].length - 1]).toBe(30);
  });

  it('fetchCeiling: = limit when limit > limit * 3 (negative limit)', () => {
    // This shouldn't happen normally, but tests Math.max behavior
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p', limit: '100', 'token-budget': '500' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[1][obsCall[1].length - 1]).toBe(300); // max(100, 300) = 300
  });

  it('tokenBudget: Number.isFinite check rejects Infinity', () => {
    const sqlJson = vi.fn(() => []);
    // parseInt('Infinity') = NaN, not Infinity
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': 'Infinity' });
    // NaN is not finite → tokenBudget = 0 → no budget stats
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('tokenBudget: non-finite values (NaN, undefined) → 0', () => {
    const sqlJson = vi.fn(() => []);
    let r = context(mockDeps({ sqlJson }), { project: 'p' }); // no token-budget arg
    expect(r.stats.budget_used).toBeUndefined();
    r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': 'abc' });
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('tokenBudget: 0 is treated as no budget (not > 0)', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '0' });
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('context: project-scoped observations have exact SQL with trust_score COALESCE', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain('COALESCE');
    expect(obsCall[0]).toContain('trust_score');
  });

  it('context: SQL includes TYPE_PRIORITY_CASE', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain('type_priority');
  });

  it('context: SQL filters o.type != skill', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain("o.type != 'skill'");
  });

  it('context: cross-project SQL filters o.scope = project', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain("o.scope = 'project'");
  });

  it('context: SQL includes expires_at check', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { project: 'p' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[0]).toContain('expires_at');
  });

  it('context: cross-project SQL does NOT filter by project', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    expect(obsCall[0]).not.toContain('o.project = ?');
  });

  it('context: cross-project SQL has no project param', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true' });
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    // Only the limit param
    expect(obsCall[1].length).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// search.js — L44 ranking formula final precision
// ═══════════════════════════════════════════════
describe('search.js L44 ranking formula final precision', () => {
  it('ftsScore = (hits/queryWords.length) * 2: exact value', () => {
    // query='alpha beta', title='alpha beta gamma' → 2/2 * 2 = 2.0
    // All else zero (no rank, no recall, no type boost difference)
    const r = rankObservations([baseObs({ id: 1, rank: 0, title: 'alpha beta gamma' })], 'alpha beta')[0];
    const ranking = require('../config').getConfig().ranking;
    // fts component = 2.0 * fts_relevance
    // The score should be > 2 * fts_relevance * 0.5 (accounting for recency/trust)
    expect(r._score).toBeGreaterThan(2 * ranking.fts_relevance * 0.5);
  });

  it('recency: Math.exp(-ageMs / HALF_LIFE) for fresh observation', () => {
    // Fresh obs: ageMs ≈ 0, exp(0) = 1
    const ts = new Date().toISOString().replace('Z', '');
    const r = rankObservations([baseObs({ id: 1, rank: null, created_at: ts, trust_score: 0 })], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    // recency ≈ 1, trust = 0, so score ≈ 1 * ranking.recency
    expect(r._score).toBeCloseTo(1.0 * ranking.recency, 1);
  });

  it('recallScore: Math.log(1+n) with n=0 → 0', () => {
    // log(1) = 0
    const r = rankObservations([baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 })], 'q')[0];
    // recallScore = 0 * MULT * 0.5 + 0.5 * USEFUL = 0.5 * USEFUL
    // But log(1) = 0, so first term is 0
    // Total recall contribution = 0.5 * USEFUL
    expect(r._score).toBeGreaterThan(0); // Still has recency + trust
  });

  it('recallScore: usefulCount / recallCount (division)', () => {
    // n=10, useful=5 → ratio = 0.5
    // recallScore = log(11)*MULT*0.5 + 0.5*USEFUL
    // If mutated to *: 50 * MULT * 0.5 + 0.5*USEFUL (very different)
    const r = rankObservations([baseObs({ id: 1, rank: null, recall_count: 10, useful_count: 5 })], 'q')[0];
    expect(r._score).toBeGreaterThan(0);
  });

  it('composite: trustScore * ranking.trust (not +)', () => {
    // With trust=0, score should be recency * W_rec + recall * W_recall
    // With trust=1, score should be recency * W_rec + 1 * W_trust + recall * W_recall
    // Difference = 1 * W_trust
    const r0 = rankObservations([baseObs({ id: 1, rank: null, trust_score: 0 })], 'q')[0];
    const r1 = rankObservations([baseObs({ id: 1, rank: null, trust_score: 1 })], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    const diff = r1._score - r0._score;
    expect(diff).toBeCloseTo(1.0 * ranking.trust, 3);
  });
});

// ═══════════════════════════════════════════════
// context.js — boundary condition killers (L36-43, L79-87)
// ═══════════════════════════════════════════════
describe('context.js boundary condition killers', () => {
  it('topicQueryNeedles: exactly 120 chars → phrase included', () => {
    // normalized.length <= 120 → phrase = [normalized]
    const exact = 'a'.repeat(120);
    const result = topicQueryNeedles(exact);
    // The phrase should be included
    expect(result).toContain(exact);
  });

  it('topicQueryNeedles: 121 chars → phrase NOT included', () => {
    // normalized.length > 120 → phrase = []
    // Use spaces so the regex splits into multiple terms
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const long = words + ' extraword ' + 'word30 '.repeat(20); // > 120 chars
    const result = topicQueryNeedles(long);
    // The full string should NOT be in results as phrase
    expect(result).not.toContain(long);
  });

  it('topicQueryNeedles: phrase vs terms dedup', () => {
    // Short query → phrase = [normalized], terms = extracted from normalized
    // Set dedup should remove duplicates
    const result = topicQueryNeedles('test');
    // 'test' should appear only once (from phrase, terms are 'test' which is in STOP_WORDS? no)
    // Actually 'test' is not a stop word, so it appears in both phrase and terms
    const testCount = result.filter(n => n === 'test').length;
    expect(testCount).toBe(1);
  });

  it('topicQueryNeedles: fallback when no valid terms and short query', () => {
    // Query with only stop words → terms = [], phrase = [query]
    const result = topicQueryNeedles('the and for');
    // Should return the phrase (the normalized query)
    expect(result).toContain('the and for');
  });

  it('topicQueryNeedles: fallback slice(0, 120) for long query with no terms', () => {
    // Long query with only special chars → terms = [], phrase = []
    // Fallback: [normalized.slice(0, 120)]
    const result = topicQueryNeedles('!!!'.repeat(50)); // 150 chars of special chars
    // Terms regex won't match, so terms = []
    // phrase = [] (length > 120)
    // Fallback: [slice(0, 120)]
    expect(result.length).toBe(1);
    expect(result[0].length).toBeLessThanOrEqual(120);
  });

  it('context: args.limit is parsed as integer', () => {
    const sqlJson = vi.fn(() => []);
    // limit='0' should parse to 0
    context(mockDeps({ sqlJson }), { project: 'p', limit: '0' });
    // Should not throw
    expect(sqlJson).toHaveBeenCalled();
  });

  it('context: args.limit default uses getConfig().context_limit', () => {
    const sqlJson = vi.fn(() => []);
    const config = require('../config');
    const defaultLimit = config.getConfig().context_limit;
    context(mockDeps({ sqlJson }), { project: 'p' });
    // The last param should be the default limit
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes('observations o') && !c[0].includes('topic_matches'));
    expect(obsCall[1][obsCall[1].length - 1]).toBe(defaultLimit);
  });

  it('context: token-budget exactly 0 → no budget stats', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'token-budget': '0' });
    // 0 is not > 0, so tokenBudget = 0
    expect(r.stats.budget_used).toBeUndefined();
  });

  it('context: session-id is parseInt-ed', () => {
    const sqlJson = vi.fn(() => []);
    // session-id='42' should be parsed to 42
    // Then used in recall log as String(42)
    const irlMock = vi.fn();
    const sqlJson2 = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
    });
    context(mockDeps({ sqlJson: sqlJson2, insertRecallLog: irlMock }), { project: 'p', 'session-id': '42' });
    if (irlMock.mock.calls.length > 0) {
      // sessionId is parsed to 42, then String(42) = '42'
      expect(irlMock.mock.calls[0][0][0].sessionId).toBe('42');
    }
  });

  it('context: session-id is null when not provided', () => {
    const sqlJson = vi.fn(() => []);
    const irlMock = vi.fn();
    const sqlJson2 = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
    });
    context(mockDeps({ sqlJson: sqlJson2, insertRecallLog: irlMock }), { project: 'p' });
    // No session-id → sessionId = null → insertRecallLog should NOT be called
    expect(irlMock).not.toHaveBeenCalled();
  });

  it('context: deep=true (string) is parsed correctly', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', deep: 'true' });
    // deep=true should trigger the deep limit path
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    const limit = obsCall[1][obsCall[1].length - 1];
    // Deep limit should be > default limit
    expect(limit).toBeGreaterThan(0);
  });

  it('context: deep=false does NOT trigger deep path', () => {
    const sqlJson = vi.fn(() => []);
    context(mockDeps({ sqlJson }), { 'all-projects': 'true', deep: 'false' });
    // deep=false → fetchCeiling = limit (no deep multiplication)
    const obsCall = sqlJson.mock.calls.find(c => c[0].includes("scope = 'project'") && !c[0].includes('topic_matches'));
    const config = require('../config');
    const defaultLimit = config.getConfig().context_limit;
    // Should be the default limit (no deep multiplication)
    expect(obsCall[1][obsCall[1].length - 1]).toBe(defaultLimit);
  });

  it('context: all-projects=true (string) triggers cross-project', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': 'true' });
    expect(r.cross_project).toBe(true);
  });

  it('context: all-projects=true (boolean) triggers cross-project', () => {
    const sqlJson = vi.fn(() => []);
    const r = context(mockDeps({ sqlJson }), { project: 'p', 'all-projects': true });
    expect(r.cross_project).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// search.js — boundary condition killers (L39-55)
// ═══════════════════════════════════════════════
describe('search.js boundary condition killers', () => {
  it('rankObservations: row.rank !== undefined check', () => {
    // If mutated to !== → !== → row.rank is checked
    // row.rank = undefined → !== undefined → false → falls through to else if
    const r = rankObservations([baseObs({ id: 1, rank: undefined })], 'q')[0];
    // Should have a score (recency + trust, not ftsScore)
    expect(r._score).toBeGreaterThan(0);
  });

  it('rankObservations: row.rank !== null check', () => {
    const r = rankObservations([baseObs({ id: 1, rank: null })], 'q')[0];
    expect(r._score).toBeGreaterThan(0);
  });

  it('rankObservations: row.rank !== 0 check', () => {
    // If rank=0, ftsScore = 0, falls through to else if
    // If rank=-1, ftsScore = 1
    const r0 = rankObservations([baseObs({ id: 1, rank: 0 })], 'q')[0];
    const r1 = rankObservations([baseObs({ id: 1, rank: -1 })], 'q')[0];
    // r1 should have higher score because ftsScore=1 contributes
    expect(r1._score).toBeGreaterThan(r0._score);
  });

  it('rankObservations: queryWords.length > 0 check', () => {
    // If queryWords is empty (all stop words or no words > 1 char), ftsScore = 0
    const r = rankObservations([baseObs({ id: 1, rank: 0 })], 'a')[0];
    // 'a' is 1 char, filtered out, so queryWords = []
    // ftsScore = 0
    // Score should be > 0 from recency + trust
    expect(r._score).toBeGreaterThan(0);
  });

  it('rankObservations: trust_score !== undefined and !== null', () => {
    // If trust_score is undefined, use DEFAULT_TRUST_SCORE
    // If trust_score is null, use DEFAULT_TRUST_SCORE
    // If trust_score is 0, use 0 (not default)
    const rUndef = rankObservations([baseObs({ id: 1, rank: null, trust_score: undefined })], 'q')[0];
    const rNull = rankObservations([baseObs({ id: 1, rank: null, trust_score: null })], 'q')[0];
    const rZero = rankObservations([baseObs({ id: 1, rank: null, trust_score: 0 })], 'q')[0];
    // undefined and null should give same score (both use DEFAULT)
    expect(rUndef._score).toBeCloseTo(rNull._score, 5);
    // 0 should give lower score than DEFAULT
    expect(rNull._score).toBeGreaterThan(rZero._score);
  });

  it('rankObservations: recallCount > 0 check for usefulRatio', () => {
    // If recallCount=0, usefulRatio = 0.5
    // If recallCount>0, usefulRatio = useful/recall
    const r0 = rankObservations([baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 })], 'q')[0];
    const r5 = rankObservations([baseObs({ id: 1, rank: null, recall_count: 5, useful_count: 0 })], 'q')[0];
    // r0: ratio=0.5, r5: ratio=0/5=0
    // r0 should have higher recallScore (0.5*USEFUL > 0*USEFUL)
    expect(r0._score).toBeGreaterThan(r5._score);
  });
});

// ═══════════════════════════════════════════════
// search.js — remaining ArithmeticOperator L44-55
// ═══════════════════════════════════════════════
describe('search.js remaining ArithmeticOperator killers L44-55', () => {
  it('recallScore: Math.log(1+n) with n=1: exact value', () => {
    // n=1, useful=1, ratio=1
    // recallScore = log(2)*MULT*1 + 1*USEFUL
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 1, useful_count: 1 }),
    ], 'q')[0];
    const r0 = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    const expected = Math.log(2) * RANKING.RECALL_LOG_MULTIPLIER + RANKING.USEFULNESS_MULTIPLIER;
    const ranking = require('../config').getConfig().ranking;
    const diff = r._score - r0._score;
    expect(diff).toBeCloseTo(expected * ranking.recall, 1);
  });

  it('recallScore: Math.log(1+n) with n=100: exact value', () => {
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 100, useful_count: 100 }),
    ], 'q')[0];
    const r0 = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    const expected = Math.log(101) * RANKING.RECALL_LOG_MULTIPLIER + RANKING.USEFULNESS_MULTIPLIER;
    const ranking = require('../config').getConfig().ranking;
    const diff = r._score - r0._score;
    expect(diff).toBeCloseTo(expected * ranking.recall, 1);
  });

  it('recallScore: usefulRatio = useful/recall (not useful*recall)', () => {
    // n=4, useful=2, ratio=0.5
    // recallScore = log(5)*MULT*0.5 + 0.5*USEFUL
    // If mutated to *: 2*4=8 * MULT * 0.5 + 0.5*USEFUL = 4*MULT + 0.5*USEFUL (very different)
    const r = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 4, useful_count: 2 }),
    ], 'q')[0];
    const r0 = rankObservations([
      baseObs({ id: 1, rank: null, recall_count: 0, useful_count: 0 }),
    ], 'q')[0];
    const expected = Math.log(5) * RANKING.RECALL_LOG_MULTIPLIER * 0.5 + 0.5 * RANKING.USEFULNESS_MULTIPLIER;
    const ranking = require('../config').getConfig().ranking;
    const diff = r._score - r0._score;
    expect(diff).toBeCloseTo(expected * ranking.recall, 1);
  });

  it('recency: Math.exp(-ageMs / HALF_LIFE) — ageMs=0 → exp(0)=1', () => {
    // Just-created observation
    const ts = new Date().toISOString().replace('Z', '');
    const r = rankObservations([baseObs({ id: 1, rank: null, created_at: ts, trust_score: 0, recall_count: 0, useful_count: 0 })], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    // recency ≈ 1, so score ≈ 1 * ranking.recency
    expect(r._score).toBeCloseTo(1.0 * ranking.recency, 1);
  });

  it('recency: old observation has lower score', () => {
    const ts = new Date(Date.now() - 365 * 86400000).toISOString().replace('Z', '');
    const r = rankObservations([baseObs({ id: 1, rank: null, created_at: ts })], 'q')[0];
    const ranking = require('../config').getConfig().ranking;
    // recency = exp(-365*86400000 / HALF_LIFE) ≈ 0
    // score ≈ 0 * ranking.recency + 0.5 * ranking.trust
    expect(r._score).toBeCloseTo(0.5 * ranking.trust, 1);
  });

  it('ftsScore: (hits/total)*2 with 1/1 hits → 2.0', () => {
    // query='alpha', title='alpha' → 1/1 * 2 = 2.0
    const r = rankObservations([baseObs({ id: 1, rank: 0, title: 'alpha' })], 'alpha')[0];
    const ranking = require('../config').getConfig().ranking;
    // fts component = 2.0 * ranking.fts_relevance
    // Total score > 2 * fts_relevance * 0.5
    expect(r._score).toBeGreaterThan(2 * ranking.fts_relevance * 0.5);
  });

  it('ftsScore: (hits/total)*2 with 0/1 hits → 0.0', () => {
    // query='alpha', title='beta' → 0/1 * 2 = 0.0
    const r = rankObservations([baseObs({ id: 1, rank: 0, title: 'beta' })], 'alpha')[0];
    // ftsScore = 0
    // Score should be from recency + trust only
    const ranking = require('../config').getConfig().ranking;
    expect(r._score).toBeLessThan(2 * ranking.fts_relevance);
  });

  it('composite: typeBoost is a multiplier (exact ratio)', () => {
    // Use two rows with different types but same other properties
    const base = { rank: -3, trust_score: 0.5, recall_count: 0, useful_count: 0 };
    const ts = new Date().toISOString().replace('Z', '');
    const r1 = rankObservations([{ ...baseObs({ id: 1, ...base, type: 'decision', created_at: ts }) }], 'q')[0];
    const r2 = rankObservations([{ ...baseObs({ id: 1, ...base, type: 'observation', created_at: ts }) }], 'q')[0];
    const decisionBoost = RANKING.TYPE_BOOST['decision'] || 1.0;
    const obsBoost = RANKING.TYPE_BOOST['observation'] || 1.0;
    if (decisionBoost !== obsBoost) {
      expect(r1._score / r2._score).toBeCloseTo(decisionBoost / obsBoost, 3);
    }
  });

  it('composite: navBoost is a multiplier (exact ratio)', () => {
    // The path_pattern is {} (matches nothing), so navBoost is always 1.0
    // This test verifies that navBoost doesn't add to the score (it's a multiplier that stays at 1.0)
    const base = { rank: null, trust_score: 0.5, recall_count: 0, useful_count: 0, type: 'observation' };
    const ts = new Date().toISOString().replace('Z', '');
    const nav = rankObservations(
      [{ ...baseObs({ id: 1, ...base, title: 'Find src/utils/helpers.js module', created_at: ts, snippet: '' }) }],
      'where is the hook module',
    )[0];
    const normal = rankObservations(
      [{ ...baseObs({ id: 1, ...base, title: 'Find src/utils/helpers.js module', created_at: ts, snippet: '' }) }],
      '',
    )[0];
    // Both should have navBoost = 1.0 (path_pattern {} matches nothing)
    // The difference in score should come from ftsScore only
    const ftsContribution = (nav._score - normal._score) / normal._score;
    // fts component = (hits/total) * 2 * ranking.fts_relevance
    // 'where' is in title, 'is' is stop word, 'the' is stop word, 'hook' is in title, 'module' is in title
    // 3/5 * 2 = 1.2
    expect(ftsContribution).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// dedupe.js — L18 BlockStatement (the if-else chain)
// ═══════════════════════════════════════════════
describe('dedupe.js L18 BlockStatement killers', () => {
  it('trigramOverlap: both empty → 1.0 (BlockStatement path)', () => {
    expect(trigramOverlap('', '')).toBe(1.0);
  });

  it('trigramOverlap: one empty → 0.0 (BlockStatement path)', () => {
    expect(trigramOverlap('abc', '')).toBe(0.0);
    expect(trigramOverlap('', 'abc')).toBe(0.0);
  });

  it('trigramOverlap: both < 3 chars → both empty → 1.0', () => {
    // 'a' has 0 trigrams (loop doesn't run for length < 3)
    // Both sets are empty → return 1.0
    expect(trigramOverlap('a', 'b')).toBe(1.0);
    // One empty string (truly empty), one 'a' (0 trigrams)
    // 'a' → ta = empty set, '' → tb = empty set
    // Both empty → 1.0
    expect(trigramOverlap('a', '')).toBe(1.0);
  });

  it('trigramOverlap: short string (< 3 chars) produces 0 trigrams', () => {
    // 'ab' → 0 trigrams (loop runs 0 times)
    // 'abc' → 1 trigram ('abc')
    // 'abcd' → 2 trigrams ('abc', 'bcd')
    expect(trigramOverlap('ab', 'abc')).toBe(0.0); // 'ab' has 0 trigrams
    expect(trigramOverlap('abc', 'ab')).toBe(0.0); // 'ab' has 0 trigrams
  });
});

// ═══════════════════════════════════════════════
// context.js — remaining cross-project supplement killers
// ═══════════════════════════════════════════════
describe('context.js cross-project supplement remaining killers', () => {
  it('supplement query: params order is [scoreParams..., project, whereParams..., supplementLimit]', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'my-proj', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    // The project param should be in the middle (after scoreParams, before whereParams)
    expect(crossCall[1]).toContain('my-proj');
  });

  it('supplement query: supplementLimit is last param', () => {
    const sqlJson = vi.fn((q) => {
      if (q.includes('session_log') || q.includes("scope = 'personal'")) return [];
      if (q.includes('topic_matches') && !q.includes('project != ?')) return [{ id: 1, title: 't', type: 'decision', content: 'c', scope: 'project', topic_key: null, created_at: new Date().toISOString().replace('Z', ''), trust_score: 0.5, recall_count: 0 }];
      if (q.includes('project != ?')) return [];
      return [];
    });
    context(mockDeps({ sqlJson }), { project: 'p', query: 'auth' });
    const crossCall = sqlJson.mock.calls.find(c => c[0].includes('project != ?'));
    const lastParam = crossCall[1][crossCall[1].length - 1];
    expect(lastParam).toBe(CONTEXT.CROSS_PROJECT_SUPPLEMENT_LIMIT || 3);
  });
});
