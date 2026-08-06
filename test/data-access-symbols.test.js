const {
  linkSymbol,
  adjustTrust,
  recordRecall,
  getRecalledMemoryIds,
  getStaleLinks,
  getSymbolsForMemory,
  findUnlinked,
} = require('../data-access/symbols');

function mockDeps() {
  return { sqlJson: vi.fn(), sqlRun: vi.fn(), sqlRaw: vi.fn() };
}

describe('data-access/symbols', () => {
  describe('linkSymbol', () => {
    it('should insert a symbol link', () => {
      const deps = mockDeps();
      const result = linkSymbol(deps, { memoryId: '1', symbolId: 'fn()', repo: 'myrepo', trust: 0.7 });
      expect(deps.sqlRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO symbol_links'),
        expect.any(Array),
      );
      expect(result.symbolId).toBe('fn()');
    });

    it('should default to __unlinked__ when symbolId is null', () => {
      const deps = mockDeps();
      const result = linkSymbol(deps, { memoryId: '1', symbolId: null, repo: 'myrepo', trust: 0.7 });
      expect(result.symbolId).toBe('__unlinked__');
    });
  });

  describe('adjustTrust', () => {
    it('should update trust score and insert adjustment', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ trust_score: 0.9 }]);
      const result = adjustTrust(deps, { memoryId: '1', delta: 0.2, reason: 'test' });
      expect(deps.sqlRun).toHaveBeenCalledTimes(2);
      expect(result).toBe(0.9);
    });
  });

  describe('recordRecall', () => {
    it('should insert recall record', () => {
      const deps = mockDeps();
      recordRecall(deps, { sessionId: 1, memoryId: '42' });
      expect(deps.sqlRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR IGNORE INTO session_recalls'),
        expect.any(Array),
      );
    });
  });

  describe('getRecalledMemoryIds', () => {
    it('queries recall_log and session_recalls', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ memory_id: '42' }]);
      const result = getRecalledMemoryIds(deps, 7);
      expect(deps.sqlJson).toHaveBeenCalledWith(expect.stringContaining('was_useful = 1'), [7, 7]);
      expect(result).toEqual([{ memory_id: '42' }]);
    });
  });

  describe('getStaleLinks', () => {
    it('should return stale links for a repo', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ memory_id: '1', symbol_id: 'fn()', trust_score: 0.3 }]);
      const result = getStaleLinks(deps, 'myrepo');
      expect(result.length).toBe(1);
    });
  });

  describe('getSymbolsForMemory', () => {
    it('should query symbol links for a memory', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ symbol_id: 'myFunc', repo: 'myrepo' }]);
      const _result = getSymbolsForMemory(deps, 42);
      expect(deps.sqlJson).toHaveBeenCalledWith(
        expect.stringContaining('symbol_links WHERE memory_id'),
        expect.any(Array),
      );
    });
  });

  describe('findUnlinked', () => {
    it('should find observations without symbol links', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ memory_id: '1' }, { memory_id: '2' }]);
      const result = findUnlinked(deps, 'myrepo');
      expect(result.length).toBe(2);
    });
  });
});
