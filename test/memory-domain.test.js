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
      2,
      '10',
      'beta',
    ]);
  });

  it('reads recall counts and computes recall scores', () => {
    const sqlJson = vi.fn(() => [{ cnt: 4 }]);
    expect(getRecallCount({ sqlJson }, 123)).toBe(4);
    expect(recallScore(4)).toBeGreaterThan(recallScore(0));
  });

  it('keeps duplicate similarity in the dedupe domain', () => {
    expect(trigramOverlap('Extract memory domain', 'Extract memory-domain')).toBeGreaterThan(0.7);
  });
});
