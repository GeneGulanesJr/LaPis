const memoryDomain = require('../src/memory-domain');
const { rankObservations } = require('../src/memory-domain/search');
const { insertRecallLog, getRecallCount, recallScore } = require('../src/memory-domain/recall');
const { trigramOverlap } = require('../src/memory-domain/dedupe');

const expectedModules = [
  'observations',
  'search',
  'context',
  'sessions',
  'recall',
  'dedupe',
  'compaction',
  'workspaces',
];

describe('src/memory-domain boundary', () => {
  it('exports the declarative memory and session domain modules', () => {
    for (const moduleName of expectedModules) {
      expect(memoryDomain[moduleName]).toBeDefined();
    }
  });

  it('keeps ranking behavior in the search domain', () => {
    const createdAt = new Date().toISOString().replace('Z', '');
    const ranked = rankObservations(
      [
        {
          id: 1,
          title: 'Session summary',
          type: 'session_summary',
          created_at: createdAt,
          trust_score: 0.5,
          recall_count: 0,
          rank: 0,
        },
        {
          id: 2,
          title: 'Important decision',
          type: 'decision',
          created_at: createdAt,
          trust_score: 0.5,
          recall_count: 3,
          rank: 0,
        },
      ],
      'decision',
    );

    expect(ranked[0].id).toBe(2);
    expect(ranked[0]._score).toBeGreaterThan(ranked[1]._score);
  });

  it('ranking: FTS rank is used when present (not zero/null)', () => {
    const ts = new Date().toISOString().replace('Z', '');
    const rows = [
      { id: 1, title: 'alpha', type: 'observation', created_at: ts, trust_score: 0.5, recall_count: 0, rank: -2.0 },
      { id: 2, title: 'beta', type: 'observation', created_at: ts, trust_score: 0.5, recall_count: 0, rank: -0.5 },
    ];
    const ranked = rankObservations(rows, 'alpha');
    // Higher FTS score (lower rank) → higher composite score
    expect(ranked[0].id).toBe(1);
    expect(ranked[0]._score).toBeGreaterThan(ranked[1]._score);
  });

  it('ranking: trust_score defaults when null/undefined', () => {
    const ts = new Date().toISOString().replace('Z', '');
    const rows = [
      { id: 1, title: 'a', type: 'observation', created_at: ts, trust_score: null, recall_count: 0, rank: -1 },
      { id: 2, title: 'b', type: 'observation', created_at: ts, trust_score: undefined, recall_count: 0, rank: -1 },
    ];
    const ranked = rankObservations(rows, 'a');
    // Both should have same trust → same score
    expect(ranked[0]._score).toBeCloseTo(ranked[1]._score, 5);
  });

  it('ranking: recall_count and useful_count affect scoring', () => {
    const ts = new Date().toISOString().replace('Z', '');
    const base = { title: 'test', type: 'observation', created_at: ts, trust_score: 0.5, rank: -1 };
    const ranked = rankObservations(
      [
        { ...base, id: 1, recall_count: 10, useful_count: 8 },
        { ...base, id: 2, recall_count: 1, useful_count: 0 },
      ],
      'test',
    );
    // Higher recall + usefulness → higher score
    expect(ranked[0].id).toBe(1);
    expect(ranked[0]._score).toBeGreaterThan(ranked[1]._score);
  });

  it('centralizes recall logging helpers', () => {
    const sqlRun = vi.fn();
    const result = insertRecallLog({ sqlRun }, [
      { memoryId: 1, sessionId: '10', query: 'alpha' },
      { memoryId: 2, sessionId: '10', query: 'beta' },
    ]);

    expect(result.inserted).toBe(2);
    expect(sqlRun).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO recall_log'), [
      1,
      '10',
      'alpha',
      1,
      2,
      '10',
      'beta',
      1,
    ]);
  });

  it('reads recall counts and computes recall scores', () => {
    const sqlJson = vi.fn(() => [{ cnt: 4 }]);
    expect(getRecallCount({ sqlJson }, 123)).toBe(4);
    expect(recallScore(4)).toBeGreaterThan(recallScore(0));
  });

  it('insertRecallLog returns 0 for null/empty entries', () => {
    const sqlRun = vi.fn();
    expect(insertRecallLog({ sqlRun }, null).inserted).toBe(0);
    expect(insertRecallLog({ sqlRun }, undefined).inserted).toBe(0);
    expect(insertRecallLog({ sqlRun }, []).inserted).toBe(0);
    expect(sqlRun).not.toHaveBeenCalled();
  });

  it('getRecallCount returns 0 when no rows found', () => {
    const sqlJson = vi.fn(() => []);
    expect(getRecallCount({ sqlJson }, 999)).toBe(0);
  });

  it('getRecallCount parses memoryId as integer', () => {
    const sqlJson = vi.fn(() => [{ cnt: 1 }]);
    getRecallCount({ sqlJson }, '42abc');
    expect(sqlJson).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.any(Number)]));
  });

  it('recallScore handles zero and undefined recall counts', () => {
    expect(recallScore(0)).toBe(0);
    expect(recallScore(undefined)).toBe(0);
    expect(recallScore(null)).toBe(0);
    // Non-zero counts must produce positive scores
    expect(recallScore(1)).toBeGreaterThan(0);
    // Score must increase with recall count (logarithmic)
    expect(recallScore(10)).toBeGreaterThan(recallScore(1));
  });

  it('keeps duplicate similarity in the dedupe domain', () => {
    expect(trigramOverlap('Extract memory domain', 'Extract memory-domain')).toBeGreaterThan(0.7);
  });

  it('trigramOverlap handles edge cases correctly', () => {
    // Both empty → perfect similarity (1.0)
    expect(trigramOverlap('', '')).toBe(1.0);
    // One empty → zero similarity
    expect(trigramOverlap('abc', '')).toBe(0.0);
    expect(trigramOverlap('', 'abc')).toBe(0.0);
    // Identical strings → 1.0
    expect(trigramOverlap('hello world', 'hello world')).toBe(1.0);
    // Completely different → low score
    expect(trigramOverlap('aaa', 'bbb')).toBe(0.0);
    // Similar strings — verify exact value uses max denominator
    const sim = trigramOverlap('test one', 'test two');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    expect(sim).toBeCloseTo(0.4, 1); // shared trigrams / max(a, b) trigrams
  });
});
