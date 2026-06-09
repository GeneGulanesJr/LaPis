const { triageReport, cleanupSessions } = require('../scripts/cleanup-sessions');

describe('scripts/cleanup-sessions', () => {
  it('should produce a triage report with zero writes in dry-run mode', () => {
    let runCount = 0;
    const deps = {
      sqlJson: vi.fn((q, params) => {
        if (q.includes('session_log') && q.includes('GROUP BY project')) {
          return [
            {
              project: 'test-proj',
              session_count: 20,
              total_memories: 50,
              first_activity: '2025-01-01',
              last_activity: '2026-06-09',
              orphan_sessions: 2,
              empty_sessions: 15,
            },
          ];
        }
        if (q.includes('user_prompts') && q.includes('NOT IN')) {
          return [{ cnt: 5 }];
        }
        if (q.includes('observations') && q.includes('GROUP BY type')) {
          return [{ type: 'decision', cnt: 10 }];
        }
        if (q.includes('pragma_page_count')) {
          return [{ page_count: 100 }];
        }
        if (q.includes('pragma_page_size')) {
          return [{ page_size: 4096 }];
        }
        return [];
      }),
      sqlRun: vi.fn(() => {
        runCount++;
      }),
    };

    const result = triageReport(deps);
    expect(result.projects).toBeDefined();
    expect(result.projects[0].name).toBe('test-proj');
    expect(result.projects[0].sessionCount).toBe(20);
    expect(runCount).toBe(0); // No writes in triage mode
  });

  it('should respect keep-last and prune sessions', () => {
    const deletedSessions = [];
    const deps = {
      sqlJson: vi.fn((q, params) => {
        // Triage: session stats
        if (q.includes('GROUP BY project') && q.includes('session_count')) {
          return [
            {
              project: 'test-proj',
              session_count: 20,
              total_memories: 50,
              first_activity: '2025-01-01',
              last_activity: '2026-06-09',
              orphan_sessions: 0,
              empty_sessions: 15,
            },
          ];
        }
        // Triage: orphan prompts
        if (q.includes('user_prompts') && q.includes('NOT IN')) {
          return [{ cnt: 0 }];
        }
        // Triage: observations
        if (q.includes('observations') && q.includes('GROUP BY type')) {
          return [];
        }
        // Triage: pragma
        if (q.includes('pragma_page_count')) return [{ page_count: 100 }];
        if (q.includes('pragma_page_size')) return [{ page_size: 4096 }];
        // Phase 1: sessions to delete (OFFSET 10)
        if (q.includes('OFFSET')) {
          return [{ id: 100 }, { id: 101 }];
        }
        // Phase 1: remaining count check
        if (q.includes('COUNT(*)') && q.includes('session_log') && q.includes('WHERE project')) {
          return [{ cnt: 20 }];
        }
        return [];
      }),
      sqlRun: vi.fn((q, params) => {
        if (q.includes('DELETE FROM session_log')) {
          deletedSessions.push(params);
        }
      }),
      softDeleteObservation: vi.fn(),
      withTransaction: vi.fn((fn) => fn()),
    };

    const result = cleanupSessions(deps, { keepLast: 10, project: 'test-proj', yes: true });
    expect(result.ok).toBe(true);
    expect(result.phases.sessionPrune.sessionsCompacted).toBe(2);
    expect(deletedSessions.length).toBe(2);
  });

  it('should refuse to delete when project has 5 or fewer sessions', () => {
    const deps = {
      sqlJson: vi.fn((q, params) => {
        if (q.includes('GROUP BY project') && q.includes('session_count')) {
          return [
            {
              project: 'small-proj',
              session_count: 5,
              total_memories: 10,
              first_activity: '2026-01-01',
              last_activity: '2026-06-09',
              orphan_sessions: 0,
              empty_sessions: 2,
            },
          ];
        }
        if (q.includes('user_prompts') && q.includes('NOT IN')) return [{ cnt: 0 }];
        if (q.includes('observations') && q.includes('GROUP BY type')) return [];
        if (q.includes('pragma_page_count')) return [{ page_count: 50 }];
        if (q.includes('pragma_page_size')) return [{ page_size: 4096 }];
        return [];
      }),
      sqlRun: vi.fn(),
      softDeleteObservation: vi.fn(),
      withTransaction: vi.fn((fn) => fn()),
    };

    const result = cleanupSessions(deps, { keepLast: 10, project: 'small-proj', yes: true });
    expect(result.ok).toBe(true);
    expect(result.phases.sessionPrune.sessionsCompacted).toBe(0);
  });

  it('should return dry-run message without --yes', () => {
    const deps = {
      sqlJson: vi.fn((q) => {
        if (q.includes('GROUP BY project') && q.includes('session_count')) {
          return [
            {
              project: 'test-proj',
              session_count: 20,
              total_memories: 50,
              first_activity: '2025-01-01',
              last_activity: '2026-06-09',
              orphan_sessions: 0,
              empty_sessions: 15,
            },
          ];
        }
        if (q.includes('user_prompts') && q.includes('NOT IN')) return [{ cnt: 0 }];
        if (q.includes('observations') && q.includes('GROUP BY type')) return [];
        if (q.includes('pragma_page_count')) return [{ page_count: 100 }];
        if (q.includes('pragma_page_size')) return [{ page_size: 4096 }];
        return [];
      }),
      sqlRun: vi.fn(),
    };

    const result = cleanupSessions(deps, { keepLast: 10 });
    expect(result.message).toContain('Dry run');
    expect(result.triage).toBeDefined();
  });

  it('should filter to a specific project when --project is set', () => {
    const deps = {
      sqlJson: vi.fn((q, params) => {
        if (q.includes('GROUP BY project') && q.includes('session_count')) {
          return [
            { project: 'proj-a', session_count: 20, total_memories: 50, first_activity: '2025-01-01', last_activity: '2026-06-09', orphan_sessions: 0, empty_sessions: 15 },
            { project: 'proj-b', session_count: 30, total_memories: 80, first_activity: '2025-01-01', last_activity: '2026-06-09', orphan_sessions: 0, empty_sessions: 20 },
          ];
        }
        if (q.includes('user_prompts') && q.includes('NOT IN')) return [{ cnt: 0 }];
        if (q.includes('observations') && q.includes('GROUP BY type')) return [];
        if (q.includes('pragma_page_count')) return [{ page_count: 100 }];
        if (q.includes('pragma_page_size')) return [{ page_size: 4096 }];
        if (q.includes('OFFSET')) return [{ id: 200 }];
        if (q.includes('COUNT(*)') && q.includes('session_log') && q.includes('WHERE project')) return [{ cnt: 30 }];
        return [];
      }),
      sqlRun: vi.fn(),
      softDeleteObservation: vi.fn(),
      withTransaction: vi.fn((fn) => fn()),
    };

    const result = cleanupSessions(deps, { keepLast: 10, project: 'proj-b', yes: true });
    expect(result.ok).toBe(true);
    // Should only process proj-b, not proj-a
    expect(result.phases.sessionPrune.sessionsCompacted).toBe(1);
  });
});
