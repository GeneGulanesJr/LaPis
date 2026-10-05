// FTS self-heal under index corruption: when the external-content index
// Corrupts under write churn (SQLITE_CORRUPT_VTAB / 'database disk image is
// Malformed'), search must rebuild once and retry instead of silently
// Degrading to LIKE forever.
const { search, __resetFtsHealForTests } = require('../src/memory-domain/search');

function mockDeps({ sqlJson, sqlRun }) {
  return {
    sqlJson,
    sqlRun,
    jsonErrNoExit: (msg) => ({ error: msg }),
    searchCode: null,
  };
}

function baseObs({ id, snippet = 's', rank = -1 }) {
  return {
    id,
    title: `obs ${id}`,
    type: 'decision',
    project: 'test',
    scope: 'project',
    topic_key: null,
    created_at: '2026-10-01 00:00:00',
    snippet,
    rank,
    trust_score: null,
    recall_count: 0,
    useful_count: 0,
  };
}

describe('search FTS self-heal on index corruption', () => {
  beforeEach(() => {
    __resetFtsHealForTests();
  });

  it('rebuilds once and retries when the FTS query throws a corruption error', () => {
    let calls = 0;
    const sqlJson = vi.fn(() => {
        calls++;
        if (calls === 1) {
          throw new Error('SQL error: database disk image is malformed');
        }
        return [baseObs({ id: 7 })];
      }),
      sqlRun = vi.fn();
    const result = search(mockDeps({ sqlJson, sqlRun }), { query: 'redis cache' });
    expect(sqlRun).toHaveBeenCalledTimes(1);
    expect(String(sqlRun.mock.calls[0][0])).toContain("VALUES('rebuild')");
    expect(result.results.length).toBe(1);
    expect(result.ftsRepaired).toBe(true);
  });

  it('does not heal on non-corruption errors and still degrades gracefully', () => {
    // Realistic shape: only FTS (MATCH) queries fail — LIKE does not touch the
    // FTS table and succeeds with zero rows.
    const sqlJson = vi.fn((q) => {
        if (/MATCH/.test(q)) {
          throw new Error('no such table: observations_fts');
        }
        return [];
      }),
      sqlRun = vi.fn();
    const result = search(mockDeps({ sqlJson, sqlRun }), { query: 'redis cache' });
    expect(sqlRun).not.toHaveBeenCalled();
    expect(result.ftsRepaired).toBe(false);
    expect(result.results).toEqual([]);
  });

  it('attempts the heal at most once per process even if corruption persists', () => {
    const sqlJson = vi.fn((q) => {
        if (/MATCH/.test(q)) {
          throw new Error('database disk image is malformed');
        }
        return [];
      }),
      sqlRun = vi.fn(() => {
        throw new Error('rebuild failed too');
      });
    search(mockDeps({ sqlJson, sqlRun }), { query: 'alpha beta' });
    search(mockDeps({ sqlJson, sqlRun }), { query: 'gamma delta' });
    expect(sqlRun).toHaveBeenCalledTimes(1);
  });

  it('skips healing entirely when sqlRun is unavailable', () => {
    const sqlJson = vi.fn((q) => {
      if (/MATCH/.test(q)) {
        throw new Error('database disk image is malformed');
      }
      return [];
    });
    const result = search(mockDeps({ sqlJson, sqlRun: undefined }), { query: 'alpha beta' });
    expect(result.ftsRepaired).toBe(false);
  });
});
