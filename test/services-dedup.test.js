const { trigramOverlap, checkDuplicate, markDuplicate } = require('../services/dedup');

describe('services/dedup: trigramOverlap', () => {
  it('should return 1.0 for exact same strings', () => {
    expect(trigramOverlap('hello world', 'hello world')).toBe(1.0);
  });

  it('should return 0.0 or near 0 for completely different strings', () => {
    const score = trigramOverlap('aaa', 'zzz');
    expect(score).toBeLessThanOrEqual(0.05);
  });

  it('should return a high score for similar strings', () => {
    const score = trigramOverlap('use sqlite for storage', 'use sqlite for caching');
    expect(score).toBeGreaterThan(0.5);
  });

  it('should return 1.0 when both strings are empty', () => {
    expect(trigramOverlap('', '')).toBe(1.0);
  });

  it('should return 0.0 when one string is empty', () => {
    expect(trigramOverlap('hello', '')).toBe(0.0);
    expect(trigramOverlap('', 'hello')).toBe(0.0);
  });

  it('should be case-insensitive', () => {
    const score = trigramOverlap('Hello World', 'hello world');
    expect(score).toBe(1.0);
  });

  it('should ignore non-alphanumeric characters', () => {
    const score = trigramOverlap('hello-world_test', 'helloworldtest');
    expect(score).toBe(1.0);
  });

  it('should handle short strings with no trigrams', () => {
    const score = trigramOverlap('ab', 'ab');
    expect(score).toBe(1.0);
  });
});

describe('services/dedup: checkDuplicate', () => {
  it('should return potential_duplicates from candidates', () => {
    const mockCandidates = [
        { id: 1, title: 'Fix login bug in auth module', topic_key: null, created_at: '2025-01-01T00:00:00Z' },
      ],
      deps = {
        sqlJson: vi.fn(() => mockCandidates),
      },
      result = checkDuplicate(deps, 'Fix login bug in auth module', 'bugfix', null, null);
    expect(result.potential_duplicates).toBeDefined();
    expect(result.potential_duplicates.length).toBe(1);
    expect(result.potential_duplicates[0].id).toBe(1);
    expect(result.potential_duplicates[0].similarity).toBeGreaterThan(0.5);
  });

  it('should filter by warning threshold', () => {
    const mockCandidates = [
        { id: 1, title: 'Completely unrelated topic here', topic_key: null, created_at: '2025-01-01T00:00:00Z' },
      ],
      deps = {
        sqlJson: vi.fn(() => mockCandidates),
      },
      result = checkDuplicate(deps, 'Fix login bug in auth module', 'bugfix', null, null);
    expect(result.potential_duplicates).toBeDefined();
    expect(result.potential_duplicates.length).toBe(0);
  });

  it('should respect project filter', () => {
    const deps = {
      sqlJson: vi.fn(() => []),
    };
    checkDuplicate(deps, 'Test title', 'decision', 'my-project', null);
    const call = deps.sqlJson.mock.calls[0],
      query = call[0],
      params = call[1];
    expect(query).toContain('AND project = ?');
    expect(params).toContain('my-project');
  });

  it('should pass type filter to SQL query', () => {
    const deps = {
      sqlJson: vi.fn(() => []),
    },
    params = (() => {

      checkDuplicate(deps, 'Test title', 'bugfix', null, null);
      
  return (deps.sqlJson.mock.calls[0][1]);
})();expect(params[0]).toBe('bugfix');
  });
});

describe('services/dedup: markDuplicate', () => {
  it('should require source and target', () => {
    const deps = {
        sqlJson: vi.fn(),
        sqlRun: vi.fn(),
        softDeleteObservation: vi.fn(),
      },
      result = markDuplicate(deps, { source: '', target: '' });
    expect(result.error).toBeDefined();
    expect(result.error).toContain('source');
  });

  it('should reject identical source and target', () => {
    const deps = {
        sqlJson: vi.fn(),
        sqlRun: vi.fn(),
        softDeleteObservation: vi.fn(),
      },
      result = markDuplicate(deps, { source: '10', target: '10' });
    expect(result.error).toMatch(/different/i);
    expect(deps.softDeleteObservation).not.toHaveBeenCalled();
  });

  it('should call softDeleteObservation with target', () => {
    const deps = {
        sqlJson: vi.fn(),
        sqlRun: vi.fn(),
        softDeleteObservation: vi.fn(),
      },
      result = markDuplicate(deps, { source: '10', target: '20' });
    expect(result.ok).toBe(true);
    expect(result.merged.kept).toBe(10);
    expect(result.merged.removed).toBe(20);
    expect(deps.softDeleteObservation).toHaveBeenCalledWith(20);
  });

  it('should insert relation row with confidence', () => {
    const deps = {
      sqlJson: vi.fn(),
      sqlRun: vi.fn(),
      softDeleteObservation: vi.fn(),
    };
    markDuplicate(deps, { source: '5', target: '10', confidence: '0.9' });
    expect(deps.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining('observation_relations'),
      expect.arrayContaining([5, 10, 'duplicate', 0.9]),
    );
  });

  it('should use default confidence when not provided', () => {
    const deps = {
      sqlJson: vi.fn(),
      sqlRun: vi.fn(),
      softDeleteObservation: vi.fn(),
    },
    callArgs = (() => {

      markDuplicate(deps, { source: '1', target: '2' });
      
  return (deps.sqlRun.mock.calls[0]);
})();expect(callArgs[1][3]).toBeDefined();
  });
});
