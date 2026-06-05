const { CONTEXT } = require('../constants');
const { context } = require('../src/memory-domain/context');

function mockFn(impl = () => undefined) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.mock = { calls };
  return fn;
}

function makeDeps(observations = []) {
  return {
    sqlJson: mockFn((q) => {
      if (typeof q === 'string' && q.includes('FROM observations') && q.includes("scope = 'personal'")) {
        return [];
      }
      if (typeof q === 'string' && q.includes('FROM session_log')) {
        return [];
      }
      if (typeof q === 'string' && q.includes('FROM observations')) {
        return observations;
      }
      if (typeof q === 'string' && q.includes('COUNT(*)')) {
        return [{ cnt: 0 }];
      }
      return [];
    }),
    jsonErrNoExit: mockFn(),
    insertRecallLog: mockFn(),
    countObservationsByProjectAndType: mockFn(() => 0),
  };
}

function makeObs(id, type, contentLen = 100, title = `Memory ${id}`) {
  return {
    id,
    title,
    type,
    scope: 'project',
    topic_key: null,
    created_at: '2026-05-23T00:00:00Z',
    trust_score: 0.9,
    recall_count: 1,
    type_priority: 1,
    content: 'x'.repeat(contentLen),
  };
}

describe('CONTEXT.TOKEN_BUDGET constants', () => {
  test('TOKEN_BUDGET_DEFAULT is 2000', () => {
    expect(CONTEXT.TOKEN_BUDGET_DEFAULT).toBe(2000);
  });

  test('TOKEN_BUDGET_MIN is 500', () => {
    expect(CONTEXT.TOKEN_BUDGET_MIN).toBe(500);
  });

  test('NEVER_TRUNCATE_TYPES contains decision and architecture', () => {
    expect(CONTEXT.NEVER_TRUNCATE_TYPES).toContain('decision');
    expect(CONTEXT.NEVER_TRUNCATE_TYPES).toContain('architecture');
  });

  test('TRUNCATE_CONTENT_CHARS is defined', () => {
    expect(typeof CONTEXT.TRUNCATE_CONTENT_CHARS).toBe('number');
    expect(CONTEXT.TRUNCATE_CONTENT_CHARS).toBeGreaterThan(0);
  });

  test('HEADERS_ONLY_LIMIT is 3', () => {
    expect(CONTEXT.HEADERS_ONLY_LIMIT).toBe(3);
  });
});

describe('context() with token-budget', () => {
  test('without --token-budget, observations pass through unchanged', () => {
    const observations = [makeObs(1, 'decision', 100), makeObs(2, 'bugfix', 100)];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject' });

    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].content).toBe('x'.repeat(100));
    expect(result.stats.budget_tokens).toBeUndefined();
    expect(result.stats.budget_used).toBeUndefined();
  });

  test('with --token-budget, includes budget stats in result', () => {
    const observations = [makeObs(1, 'decision', 50), makeObs(2, 'bugfix', 50)];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '500' });

    expect(result.stats.budget_tokens).toBe(500);
    expect(typeof result.stats.budget_used).toBe('number');
    expect(result.stats.budget_used).toBeGreaterThan(0);
    expect(result.stats.total_count).toBe(2);
  });

  test('truncates content when budget is tight', () => {
    const observations = [
      makeObs(1, 'discovery', 2000, 'Big discovery'),
      makeObs(2, 'discovery', 2000, 'Another big one'),
      makeObs(3, 'learning', 2000, 'Yet another'),
    ];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '600' });

    expect(result.observations.length).toBeLessThanOrEqual(3);
    const truncated = result.observations.filter((o) => o._truncated);
    expect(truncated.length).toBeGreaterThan(0);
    expect(result.stats.truncated_count).toBeGreaterThan(0);
    expect(result.stats.total_count).toBe(3);
  });

  test('never truncates decision type even when over budget', () => {
    const observations = [
      makeObs(1, 'decision', 5000, 'Critical decision'),
      makeObs(2, 'discovery', 5000, 'Discovery'),
    ];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '800' });

    const decision = result.observations.find((o) => o.type === 'decision');
    expect(decision).toBeDefined();
    expect(decision.content).toBe('x'.repeat(5000));
    expect(decision._truncated).not.toBe(true);
  });

  test('never truncates architecture type even when over budget', () => {
    const observations = [
      makeObs(1, 'architecture', 5000, 'Critical architecture'),
      makeObs(2, 'learning', 5000, 'Learning'),
    ];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '800' });

    const arch = result.observations.find((o) => o.type === 'architecture');
    expect(arch).toBeDefined();
    expect(arch.content).toBe('x'.repeat(5000));
  });

  test('returns headers only when budget is below TOKEN_BUDGET_MIN', () => {
    const observations = [
      makeObs(1, 'decision', 100, 'First'),
      makeObs(2, 'bugfix', 100, 'Second'),
      makeObs(3, 'pattern', 100, 'Third'),
      makeObs(4, 'discovery', 100, 'Fourth'),
      makeObs(5, 'learning', 100, 'Fifth'),
    ];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '400' });

    expect(result.observations.length).toBeLessThanOrEqual(CONTEXT.HEADERS_ONLY_LIMIT);
    for (const o of result.observations) {
      expect(o._truncated).toBe(true);
      expect(o.content).toBe('');
    }
  });

  test('handles zero or invalid budget gracefully (treats as no budget)', () => {
    const observations = [makeObs(1, 'decision', 100), makeObs(2, 'bugfix', 100)];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '0' });

    expect(result.observations).toHaveLength(2);
    expect(result.stats.budget_tokens).toBeUndefined();
  });

  test('handles negative budget as no budget', () => {
    const observations = [makeObs(1, 'decision', 100)];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '-100' });

    expect(result.observations).toHaveLength(1);
    expect(result.stats.budget_tokens).toBeUndefined();
  });

  test('stops adding observations when budget is exhausted', () => {
    const observations = Array.from({ length: 10 }, (_, i) => makeObs(i + 1, 'discovery', 500));
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '700' });

    expect(result.observations.length).toBeLessThan(10);
    expect(result.stats.budget_used).toBeLessThanOrEqual(700);
  });

  test('prefers truncation to dropping entirely', () => {
    const observations = [
      makeObs(1, 'discovery', 1000, 'Important discovery'),
      makeObs(2, 'learning', 100, 'Quick learning'),
    ];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '600' });

    expect(result.observations.length).toBe(2);
    const discovery = result.observations.find((o) => o.id === 1);
    const learning = result.observations.find((o) => o.id === 2);
    expect(learning.content).toBe('x'.repeat(100));
    expect(learning._truncated).not.toBe(true);
  });

  test('headers-only branch respects budget (no overflow)', () => {
    // With budget=50 and 5 observations, headers should not exceed 50 tokens total
    const observations = Array.from({ length: 5 }, (_, i) =>
      makeObs(i + 1, 'discovery', 100, `Very Long Title For Memory Number ${i + 1}`),
    );
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '50' });

    expect(result.stats.budget_used).toBeLessThanOrEqual(50);
    for (const o of result.observations) {
      expect(o._truncated).toBe(true);
      expect(o.content).toBe('');
    }
  });

  test('continues processing after successful header fallback', () => {
    // First obs is large (gets truncated to header), second is small (fits fully)
    const observations = [
      makeObs(1, 'discovery', 5000, 'Huge discovery'),
      makeObs(2, 'learning', 10, 'Tiny learning'),
    ];
    const deps = makeDeps(observations);
    const result = context(deps, { project: 'TestProject', 'token-budget': '600' });

    // Both observations should be present
    expect(result.observations.length).toBe(2);
    // First should be truncated
    expect(result.observations.find((o) => o.id === 1)._truncated).toBe(true);
    // Second should be intact (it fits in remaining budget)
    const tiny = result.observations.find((o) => o.id === 2);
    expect(tiny.content).toBe('x'.repeat(10));
  });
});
