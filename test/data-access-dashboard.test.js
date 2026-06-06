const { getDashboard } = require('../data-access/dashboard');

function mockDeps() {
  return {
    sqlJson: vi.fn(),
    sqlRun: vi.fn(),
  };
}

describe('data-access/dashboard', () => {
  describe('getDashboard', () => {
    it('should return overview with all fields', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 560 }])
        .mockReturnValueOnce([{ cnt: 4 }])
        .mockReturnValueOnce([{ cnt: 12 }])
        .mockReturnValueOnce([{ cnt: 3 }])
        .mockReturnValueOnce([{ avg: 0.78 }])
        .mockReturnValueOnce([{ cnt: 34 }])
        .mockReturnValueOnce([{ cnt: 2 }])
        .mockReturnValueOnce([
          { type: 'decision', cnt: 142 },
          { type: 'bugfix', cnt: 89 },
        ])
        .mockReturnValueOnce([{
          high: 80, medium: 30, low: 12, total: 122,
        }])
        .mockReturnValueOnce([{
          totalRecalls: 250, usefulRate: 0.72, uniqueMemoriesHit: 180,
        }])
        .mockReturnValueOnce([{ value: '2026-06-04T10:00:00.000Z' }])
        .mockReturnValueOnce([{ value: '47' }])
        .mockReturnValueOnce([{ value: '9' }])
        .mockReturnValueOnce([
          { name: 'PiMemoryExtension', path: '/some/path', file_count: 359, symbol_count: 8874, indexed_at: '2026-06-01', base_head: 'abc123' },
        ]);

      const result = getDashboard(deps);

      expect(result.overview.totalMemories).toBe(560);
      expect(result.overview.totalProjects).toBe(4);
      expect(result.overview.thisWeekSaved).toBe(12);
      expect(result.overview.thisWeekCleaned).toBe(3);
      expect(result.overview.avgTrust).toBe(0.78);
      expect(result.overview.neverRecalled).toBe(34);
      expect(result.overview.expiringSoon).toBe(2);
    });

    it('should return byType array sorted by count desc', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 100 }])
        .mockReturnValueOnce([{ cnt: 1 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ avg: null }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([
          { type: 'decision', cnt: 50 },
          { type: 'bugfix', cnt: 30 },
          { type: 'discovery', cnt: 20 },
        ])
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }])
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([]);

      const result = getDashboard(deps);
      expect(result.byType).toHaveLength(3);
      expect(result.byType[0].type).toBe('decision');
      expect(result.byType[0].count).toBe(50);
    });

    it('should return trust distribution with none count', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 200 }])
        .mockReturnValueOnce([{ cnt: 2 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ avg: 0.9 }])
        .mockReturnValueOnce([{ cnt: 10 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ high: 80, medium: 30, low: 12, total: 122 }])
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([]);

      const result = getDashboard(deps);
      expect(result.trust.distribution.high).toBe(80);
      expect(result.trust.distribution.medium).toBe(30);
      expect(result.trust.distribution.low).toBe(12);
      expect(result.trust.distribution.none).toBe(200 - 122);
      expect(result.trust.lowTrustCount).toBe(12);
    });

    it('should return dream stats as null when no settings exist', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ avg: null }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }])
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([]);

      const result = getDashboard(deps);
      expect(result.dream.lastRun).toBeNull();
      expect(result.dream.totalCleaned).toBeNull();
      expect(result.dream.runCount).toBeNull();
    });

    it('should return codeIndex entries with path and base_head', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ avg: null }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }])
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([
          { name: 'test-repo', path: '/tmp/test', file_count: 10, symbol_count: 50, indexed_at: '2026-06-01', base_head: 'abc123' },
        ]);

      const result = getDashboard(deps);
      expect(result.codeIndex).toHaveLength(1);
      expect(result.codeIndex[0].name).toBe('test-repo');
      expect(result.codeIndex[0].path).toBe('/tmp/test');
      expect(result.codeIndex[0].base_head).toBe('abc123');
      expect(result.codeIndex[0].isStale).toBeUndefined();
    });

    it('should gracefully handle missing expires_at column', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockReturnValueOnce([{ avg: null }])
        .mockReturnValueOnce([{ cnt: 0 }])
        .mockImplementationOnce(() => { throw new Error('no such column: expires_at'); })
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }])
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([]);

      const result = getDashboard(deps);
      expect(result.overview.expiringSoon).toBe(0);
    });
  });
});
