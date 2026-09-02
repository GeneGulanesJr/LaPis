const { CONTEXT, RANKING } = require('../constants');
const { context } = require('../src/memory-domain/context');

function mockFn(impl = () => undefined) {
  const calls = [],
    fn = (...args) => {
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

describe('CONTEXT constants for filtering', () => {
  test('EXCLUDED_TYPES contains progress and accomplished', () => {
    expect(CONTEXT.EXCLUDED_TYPES).toContain('progress');
    expect(CONTEXT.EXCLUDED_TYPES).toContain('accomplished');
    expect(CONTEXT.EXCLUDED_TYPES).toContain('session_summary');
  });

  test('DEFAULT_LIMIT is 10', () => {
    expect(CONTEXT.DEFAULT_LIMIT).toBe(10);
  });

  test('EXCLUDED_TYPES does not contain decision or bugfix', () => {
    expect(CONTEXT.EXCLUDED_TYPES).not.toContain('decision');
    expect(CONTEXT.EXCLUDED_TYPES).not.toContain('bugfix');
    expect(CONTEXT.EXCLUDED_TYPES).not.toContain('architecture');
    expect(CONTEXT.EXCLUDED_TYPES).not.toContain('pattern');
  });
});

describe('context() excludes low-signal types', () => {
  test('excludes progress and accomplished from default project context', () => {
    const mixedObservations = [
        {
          id: 1,
          title: 'Progress checkpoint (turn 10)',
          type: 'progress',
          scope: 'project',
          topic_key: null,
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.9,
          recall_count: 5,
          type_priority: 0,
        },
        {
          id: 2,
          title: 'Edited db.test.js',
          type: 'accomplished',
          scope: 'project',
          topic_key: null,
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.9,
          recall_count: 3,
          type_priority: 0,
        },
        {
          id: 3,
          title: 'Architecture choice: FTS5',
          type: 'decision',
          scope: 'project',
          topic_key: 'search',
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.8,
          recall_count: 2,
          type_priority: 3,
        },
        {
          id: 4,
          title: 'Bug fix: config save/restore',
          type: 'bugfix',
          scope: 'project',
          topic_key: 'config',
          created_at: '2026-05-22T00:00:00Z',
          trust_score: 0.7,
          recall_count: 1,
          type_priority: 2,
        },
      ],
      deps = makeDeps(mixedObservations),
      result = context(deps, { project: 'TestProject' }),
      types = result.observations.map((o) => o.type);
    expect(types).not.toContain('progress');
    expect(types).not.toContain('accomplished');
    expect(types).toContain('decision');
    expect(types).toContain('bugfix');
  });

  test('excludes progress and accomplished from cross-project context', () => {
    const mixedObservations = [
        {
          id: 1,
          title: 'Progress checkpoint (turn 80)',
          type: 'progress',
          scope: 'project',
          topic_key: null,
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.9,
          recall_count: 10,
          type_priority: 0,
          project: 'Other',
        },
        {
          id: 2,
          title: 'Fixed auth middleware',
          type: 'bugfix',
          scope: 'project',
          topic_key: 'auth',
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.8,
          recall_count: 3,
          type_priority: 2,
          project: 'Other',
        },
      ],
      deps = makeDeps(mixedObservations),
      result = context(deps, { 'all-projects': 'true' }),
      types = result.observations.map((o) => o.type);
    expect(types).not.toContain('progress');
    expect(types).toContain('bugfix');
  });

  test('excludes progress from topic-key context', () => {
    const observations = [
        {
          id: 1,
          title: 'Progress checkpoint (turn 10)',
          type: 'progress',
          scope: 'project',
          topic_key: null,
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.9,
          recall_count: 5,
          type_priority: 0,
        },
        {
          id: 2,
          title: 'Decision: use SQLite',
          type: 'decision',
          scope: 'project',
          topic_key: 'db',
          created_at: '2026-05-23T00:00:00Z',
          trust_score: 0.8,
          recall_count: 2,
          type_priority: 3,
        },
      ],
      deps = makeDeps(observations),
      result = context(deps, { project: 'TestProject', 'topic-key': 'db' }),
      types = result.observations.map((o) => o.type);
    expect(types).not.toContain('progress');
    expect(types).toContain('decision');
  });
});

describe('context-injection limit', () => {
  test('CONTEXT.DEFAULT_LIMIT is used instead of hardcoded 15', () => {
    expect(CONTEXT.DEFAULT_LIMIT).toBe(10);
    expect(CONTEXT.DEFAULT_LIMIT).toBeLessThan(15);
  });
});

describe('RANKING.TYPE_PRIORITY for low-signal types', () => {
  test('progress has priority -1 (below default 0)', () => {
    expect(RANKING.TYPE_PRIORITY.progress).toBe(-1);
  });

  test('accomplished has priority -1', () => {
    expect(RANKING.TYPE_PRIORITY.accomplished).toBe(-1);
  });

  test('session_summary has priority <= 0', () => {
    expect(RANKING.TYPE_PRIORITY.session_summary).toBeLessThanOrEqual(0);
  });
});
