const { context } = require('../services/context');

describe('services/context', () => {
  it('should default to cross-project mode when project is missing', () => {
    const observations = [
        {
          id: 1,
          title: 'Global',
          type: 'decision',
          scope: 'project',
          topic_key: 'x',
          created_at: '2025-01-01',
          trust_score: 0.7,
          recall_count: 2,
          type_priority: 3,
        },
      ],
      sqlJson = vi.fn((query, _params) => {
        if (query.includes("scope = 'personal'")) {
          return [];
        }
        return observations;
      }),
      jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
      countObservationsByProjectAndType = vi.fn(() => 5),
      result = context(
        {
          sqlJson,
          sqlRun: vi.fn(),
          jsonErrNoExit,
          insertRecallLog: vi.fn(),
          countObservationsByProjectAndType,
          searchCode: vi.fn(),
        },
        {},
      );
    expect(result.cross_project).toBe(true);
    expect(jsonErrNoExit).not.toHaveBeenCalled();
  });

  it('should return observations and sessions for a project', () => {
    const sessions = [{ id: 1, project: 'test', started_at: '2025-01-01', ended_at: '2025-01-01', memories_saved: 3 }],
      observations = [
        {
          id: 10,
          title: 'Dec 1',
          type: 'decision',
          scope: 'project',
          topic_key: 'arch',
          created_at: '2025-01-01',
          trust_score: 0.8,
          recall_count: 5,
          type_priority: 3,
        },
      ],
      personal = [
        { id: 20, title: 'My note', type: 'preference', scope: 'personal', topic_key: null, created_at: '2025-01-01' },
      ],
      sqlJson = vi.fn((query, _params) => {
        if (query.includes('session_log') && query.includes('WHERE project')) {
          return sessions;
        }
        if (query.includes("scope = 'personal'")) {
          return personal;
        }
        return observations;
      }),
      sqlRun = vi.fn(),
      jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
      insertRecallLog = vi.fn(),
      countObservationsByProjectAndType = vi.fn(() => 10),
      result = context(
        { sqlJson, sqlRun, jsonErrNoExit, insertRecallLog, countObservationsByProjectAndType, searchCode: vi.fn() },
        { project: 'test', 'session-id': '5' },
      );
    expect(result.project).toBe('test');
    expect(result.observations).toBeDefined();
    expect(result.sessions).toEqual(sessions);
    expect(result.personal).toEqual(personal);
    expect(result.stats).toBeDefined();
  });

  it('should work with all-projects mode', () => {
    const observations = [
        {
          id: 1,
          title: 'Global',
          type: 'decision',
          scope: 'project',
          topic_key: 'x',
          created_at: '2025-01-01',
          trust_score: 0.7,
          recall_count: 2,
          type_priority: 3,
        },
      ],
      sqlJson = vi.fn((query, _params) => {
        if (query.includes("scope = 'personal'")) {
          return [];
        }
        return observations;
      }),
      jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
      countObservationsByProjectAndType = vi.fn(() => 5),
      result = context(
        {
          sqlJson,
          sqlRun: vi.fn(),
          jsonErrNoExit,
          insertRecallLog: vi.fn(),
          countObservationsByProjectAndType,
          searchCode: vi.fn(),
        },
        { 'all-projects': 'true' },
      );
    expect(result.cross_project).toBe(true);
    expect(result.observations).toBeDefined();
  });

  it('should filter by topic key', () => {
    const observations = [
        {
          id: 1,
          title: 'Topic',
          type: 'decision',
          scope: 'project',
          topic_key: 'arch',
          created_at: '2025-01-01',
          trust_score: 0.8,
          recall_count: 0,
          type_priority: 3,
        },
      ],
      sqlJson = vi.fn((query, _params) => {
        if (query.includes("scope = 'personal'")) {
          return [];
        }
        return observations;
      }),
      jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
      countObservationsByProjectAndType = vi.fn(() => 2),
      result = context(
        {
          sqlJson,
          sqlRun: vi.fn(),
          jsonErrNoExit,
          insertRecallLog: vi.fn(),
          countObservationsByProjectAndType,
          searchCode: vi.fn(),
        },
        { project: 'test', 'topic-key': 'arch' },
      );
    expect(result.topic).toBe('arch');
  });

  it('should filter by query (topic query)', () => {
    const observations = [
        {
          id: 1,
          title: 'Query result',
          type: 'decision',
          scope: 'project',
          topic_key: null,
          created_at: '2025-01-01',
          trust_score: 0.8,
          recall_count: 0,
          type_priority: 3,
        },
      ],
      sqlJson = vi.fn((query, _params) => {
        if (query.includes("scope = 'personal'")) {
          return [];
        }
        return observations;
      }),
      jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
      countObservationsByProjectAndType = vi.fn(() => 1),
      result = context(
        {
          sqlJson,
          sqlRun: vi.fn(),
          jsonErrNoExit,
          insertRecallLog: vi.fn(),
          countObservationsByProjectAndType,
          searchCode: vi.fn(),
        },
        { project: 'test', query: 'authentication' },
      );
    expect(result.topic).toBe('authentication');
  });

  it('should tokenize topic query prompts instead of requiring an exact phrase match', () => {
    const observations = [
      {
        id: 1,
        title: 'Architecture choice: LaPis uses SQLite FTS5 for memory search to avoid external dependencies',
        type: 'architecture',
        scope: 'project',
        topic_key: 'search/fts5-rationale',
        created_at: '2025-01-01',
        trust_score: 0.8,
        recall_count: 0,
        type_priority: 3,
      },
    ];
    let observationQuery = '',
      observationParams = [];
    const sqlJson = vi.fn((query, params) => {
        if (query.includes("scope = 'personal'")) {
          return [];
        }
        if (query.includes('session_log')) {
          return [];
        }
        if (query.includes('topic_matches')) {
          observationQuery = query;
          observationParams = params;
        }
        return observations;
      }),
      result = context(
        {
          sqlJson,
          sqlRun: vi.fn(),
          jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
          insertRecallLog: vi.fn(),
          countObservationsByProjectAndType: vi.fn(() => 1),
          searchCode: vi.fn(),
        },
        {
          project: 'test',
          query:
            'Why did LaPis choose SQLite FTS5 for memory search instead of an external search service? Keep the answer concise.',
        },
      );

    expect(result.observations).toEqual(observations);
    expect(observationQuery).toContain('match_score');
    expect(observationParams).toContain('%sqlite%');
    expect(observationParams).toContain('%fts5%');
    expect(observationParams).toContain('%external%');
  });

  it('escapes backslash before LIKE wildcards in topic query needles', () => {
    const { buildTopicQueryMatch } = require('../services/context');
    const { whereParams } = buildTopicQueryMatch(['50%_off\\']);
    // Backslash escaped first ("\" -> "\\"), then % and _ -> "\%", "\_":
    // a trailing "\" can no longer escape the wildcard markers under ESCAPE '\'.
    expect(whereParams[0]).toBe('%50\\%\\_off\\\\%');
  });
});
