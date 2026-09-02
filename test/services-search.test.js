const { rankObservations, search: _search, related, symbolCluster } = require('../services/search');

describe('services/search: rankObservations', () => {
  it('should rank decisions higher than session summaries', () => {
    const rows = [
        {
          id: 1,
          title: 'Session summary',
          type: 'session_summary',
          created_at: new Date().toISOString().replace('Z', ''),
          trust_score: 0.5,
          recall_count: 0,
          rank: 0,
        },
        {
          id: 2,
          title: 'Important decision',
          type: 'decision',
          created_at: new Date().toISOString().replace('Z', ''),
          trust_score: 0.5,
          recall_count: 0,
          rank: 0,
        },
      ],
      ranked = rankObservations(rows, 'decision'),
      decisionEntry = ranked.find((r) => r.type === 'decision'),
      summaryEntry = ranked.find((r) => r.type === 'session_summary');
    expect(decisionEntry._score).toBeGreaterThan(summaryEntry._score);
  });

  it('should produce valid numeric scores (no NaN)', () => {
    const rows = [
        {
          id: 1,
          title: 'Test observation',
          type: 'decision',
          created_at: new Date().toISOString().replace('Z', ''),
          trust_score: 0.8,
          recall_count: 5,
          rank: 0,
        },
      ],
      ranked = rankObservations(rows, 'test');
    for (const r of ranked) {
      expect(typeof r._score).toBe('number');
      expect(isNaN(r._score)).toBe(false);
    }
  });

  it('should handle empty results', () => {
    const ranked = rankObservations([], 'test');
    expect(ranked).toEqual([]);
  });

  it('should produce sorted results (descending by score)', () => {
    const now = new Date().toISOString().replace('Z', ''),
      rows = [
        {
          id: 1,
          title: 'Old bugfix',
          type: 'bugfix',
          created_at: '2024-01-01T00:00:00',
          trust_score: 0.2,
          recall_count: 0,
          rank: 0,
        },
        {
          id: 2,
          title: 'New decision',
          type: 'decision',
          created_at: now,
          trust_score: 0.9,
          recall_count: 10,
          rank: 0,
        },
        {
          id: 3,
          title: 'Mid discovery',
          type: 'discovery',
          created_at: '2024-06-01T00:00:00',
          trust_score: 0.5,
          recall_count: 2,
          rank: 0,
        },
      ],
      ranked = rankObservations(rows, 'decision');
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]._score).toBeGreaterThanOrEqual(ranked[i]._score);
    }
  });

  it('should compute fts-like score from query words when rank is 0', () => {
    const rows = [
        {
          id: 1,
          title: 'Use SQLite for storage',
          type: 'decision',
          created_at: new Date().toISOString().replace('Z', ''),
          trust_score: 0.5,
          recall_count: 0,
          rank: 0,
        },
      ],
      ranked = rankObservations(rows, 'sqlite storage');
    expect(ranked[0]._score).toBeGreaterThan(0);
  });
});

describe('services/search: related', () => {
  it('should return empty related for observation with no symbol links', () => {
    const deps = {
        sqlJson: vi.fn(() => []),
        jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      },
      result = related(deps, { id: '42' });
    expect(result.related).toEqual([]);
    expect(result.memory_id).toBe(42);
  });

  it('should return grouped results for observations with symbol links', () => {
    const mockSymbols = [
        { symbol_id: 'sym1', repo: 'repo1' },
        { symbol_id: 'sym2', repo: 'repo2' },
      ],
      mockClusters = [
        {
          symbol_id: 'sym1',
          id: 100,
          title: 'Related memory 1',
          type: 'decision',
          project: 'proj1',
          created_at: '2025-01-01T00:00:00',
        },
        {
          symbol_id: 'sym2',
          id: 101,
          title: 'Related memory 2',
          type: 'bugfix',
          project: 'proj2',
          created_at: '2025-01-01T00:00:00',
        },
      ];
    let callCount = 0;
    const deps = {
        sqlJson: vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            return mockSymbols;
          }
          return mockClusters;
        }),
        jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      },
      result = related(deps, { id: '1' });
    expect(result.related.length).toBeGreaterThan(0);
    expect(result.related[0].symbol).toBeDefined();
    expect(result.related[0].memories.length).toBeGreaterThan(0);
  });

  it('should require id parameter', () => {
    const deps = {
        sqlJson: vi.fn(),
        jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      },
      result = related(deps, {});
    expect(result.error).toBeDefined();
  });
});

describe('services/search: symbolCluster', () => {
  it('should require symbol parameter', () => {
    const deps = {
        sqlJson: vi.fn(),
        jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      },
      result = symbolCluster(deps, {});
    expect(result.error).toBeDefined();
  });

  it('should query with symbol_id filter', () => {
    const mockMemories = [
        {
          id: 1,
          title: 'Memory about symbol',
          type: 'decision',
          project: 'proj',
          scope: null,
          topic_key: null,
          created_at: '2025-01-01T00:00:00',
          trust_score: 0.8,
        },
      ],
      deps = {
        sqlJson: vi.fn(() => mockMemories),
        jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      },
      result = symbolCluster(deps, { symbol: 'mySymbolId' });
    expect(result.symbol).toBe('mySymbolId');
    expect(result.memories).toEqual(mockMemories);
    expect(deps.sqlJson).toHaveBeenCalledWith(
      expect.stringContaining('symbol_id = ?'),
      expect.arrayContaining(['mySymbolId']),
    );
  });

  it('should filter by repo when provided', () => {
    const deps = {
        sqlJson: vi.fn(() => []),
        jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      },
      call = (() => {
        symbolCluster(deps, { symbol: 'sym1', repo: 'my-repo' });

        return deps.sqlJson.mock.calls[0];
      })();
    expect(call[0]).toContain('AND sl.repo = ?');
    expect(call[1]).toContain('my-repo');
  });
});
