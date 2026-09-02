const { sessionStart, sessionEnd } = require('../services/sessions');

describe('services/sessions', () => {
  describe('sessionStart', () => {
    it('should return error when project is missing', () => {
      const jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        result = sessionStart({ sqlJson: vi.fn(), sqlRun: vi.fn(), jsonErrNoExit, withTransaction: (fn) => fn() }, {});
      expect(result.error).toContain('project');
    });

    it('should create session and return session info', () => {
      const sqlJson = vi.fn((query, _params) => {
          if (query.includes('INSERT INTO session_log')) {
            return [{ id: 42, started_at: '2025-01-01T00:00:00' }];
          }
          if (query.includes('COUNT(*)')) {
            return [{ cnt: 3 }];
          }
          if (query.includes('ended_at IS NULL')) {
            return [];
          }
          if (query.includes('archive')) {
            return [];
          }
          return [];
        }),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        autoRecoverInternal = vi.fn(() => null),
        runCompact = vi.fn(() => ({ ok: true })),
        _readTierConfig = vi.fn(() => ({ tier: 'full' })),
        TOOL_TIERS = { full: null },
        commands = { search: vi.fn(), save: vi.fn() },
        result = sessionStart(
          {
            sqlJson,
            sqlRun,
            jsonErrNoExit,
            autoRecoverInternal,
            runCompact,
            _readTierConfig,
            TOOL_TIERS,
            commands,
            withTransaction: (fn) => fn(),
          },
          { project: 'my-project' },
        );
      expect(result.sessionId).toBe(42);
      expect(result.sessionCount).toBe(3);
      expect(result.tool_tier).toBe('full');
    });

    it('should detect incomplete previous session', () => {
      const sqlJson = vi.fn((query, _params) => {
          if (query.includes('INSERT INTO session_log')) {
            return [{ id: 5, started_at: '2025-01-01' }];
          }
          if (query.includes('COUNT(*)')) {
            return [{ cnt: 1 }];
          }
          if (query.includes('ended_at IS NULL')) {
            return [{ id: 4 }];
          }
          if (query.includes('archive')) {
            return [];
          }
          return [];
        }),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        autoRecoverInternal = vi.fn(() => ({ status: 'recovered', observations_processed: 2 })),
        runCompact = vi.fn(() => ({ ok: true })),
        _readTierConfig = vi.fn(() => ({ tier: 'full' })),
        TOOL_TIERS = { full: null },
        commands = { search: vi.fn() },
        result = sessionStart(
          {
            sqlJson,
            sqlRun,
            jsonErrNoExit,
            autoRecoverInternal,
            runCompact,
            _readTierConfig,
            TOOL_TIERS,
            commands,
            withTransaction: (fn) => fn(),
          },
          { project: 'my-project' },
        );
      expect(result.hasIncompletePreviousSession).toBe(true);
      expect(result.incompleteSessionId).toBe(4);
      expect(autoRecoverInternal).toHaveBeenCalledWith('4');
    });
  });

  describe('sessionEnd', () => {
    it('should return error when id is missing', () => {
      const jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        result = sessionEnd({ sqlJson: vi.fn(), sqlRun: vi.fn(), jsonErrNoExit }, {});
      expect(result.error).toContain('id');
    });

    it('should update session_log with ended_at', () => {
      const sqlJson = vi.fn(),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(() => ({ ok: true })),
        result = sessionEnd({ sqlJson, sqlRun, jsonErrNoExit, trustRecovery }, { id: '10', memories: '5' });
      expect(result.ok).toBe(true);
      expect(result.sessionId).toBe(10);
      expect(sqlRun).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE session_log'),
        expect.arrayContaining([5, 10]),
      );
    });

    it('should run trustRecovery when auto is true', () => {
      const sqlJson = vi.fn(),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(() => ({ ok: true, memoriesRecovered: 2 })),
        result = sessionEnd({ sqlJson, sqlRun, jsonErrNoExit, trustRecovery }, { id: '10', auto: 'true' });
      expect(trustRecovery).toHaveBeenCalledWith({ session: '10' });
      expect(result.trustRecovery).toBeDefined();
    });

    it('should not run trustRecovery when auto is not set', () => {
      const sqlJson = vi.fn(),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(),
        result = sessionEnd({ sqlJson, sqlRun, jsonErrNoExit, trustRecovery }, { id: '10', memories: '5' });
      expect(trustRecovery).not.toHaveBeenCalled();
      expect(result.trustRecovery).toBeUndefined();
    });

    it('should always run cheap compact at session end when runCompactCheap is provided', () => {
      const sqlJson = vi.fn(),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(() => ({ ok: true })),
        runCompactCheap = vi.fn(() => ({ ok: true, pruned: 3 })),
        runVacuum = vi.fn(() => ({ ok: true, steps: { vacuumed: true } })),
        result = sessionEnd(
          { sqlJson, sqlRun, jsonErrNoExit, trustRecovery, runCompactCheap, runVacuum },
          { id: '10', memories: '5' },
        );
      expect(runCompactCheap).toHaveBeenCalled();
      // Vacuum is gated by session count; with an unmocked count query it
      // Returns undefined and vacuum is skipped (cheap path only).
      expect(runVacuum).not.toHaveBeenCalled();
      expect(result.compacted).toEqual({ ok: true, pruned: 3 });
    });

    it('should run vacuum only when ended session count is a multiple of compact_every_n_sessions', () => {
      const sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(() => ({ ok: true })),
        runCompactCheap = vi.fn(() => ({ ok: true, startedAt: 't', steps: { expiredPurged: true } })),
        runVacuum = vi.fn(() => ({ ok: true, steps: { vacuumed: true } })),
        // Vacuum is gated by per-project session count (same query as sessionStart).
        sqlJson = vi.fn((query) => {
          if (/SELECT project FROM session_log WHERE id = \?/i.test(query)) {
            return [{ project: 'test-project' }];
          }
          if (/COUNT\(\*\) as cnt FROM session_log WHERE project = \?$/i.test(query)) {
            return [{ cnt: 10 }];
          }
          return [];
        }),
        result = sessionEnd(
          { sqlJson, sqlRun, jsonErrNoExit, trustRecovery, runCompactCheap, runVacuum },
          { id: '10', memories: '5' },
        );
      expect(runCompactCheap).toHaveBeenCalled();
      expect(runVacuum).toHaveBeenCalledTimes(1);
      expect(result.compacted.steps.vacuumed).toBe(true);
    });

    it('should skip vacuum when ended session count is not on the gated cadence', () => {
      const sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(() => ({ ok: true })),
        runCompactCheap = vi.fn(() => ({ ok: true, steps: { expiredPurged: true } })),
        runVacuum = vi.fn(() => ({ ok: true })),
        // 7 sessions → not divisible by 5 → vacuum NOT due.
        sqlJson = vi.fn((query) => {
          if (/SELECT project FROM session_log WHERE id = \?/i.test(query)) {
            return [{ project: 'test-project' }];
          }
          if (/COUNT\(\*\) as cnt FROM session_log WHERE project = \?$/i.test(query)) {
            return [{ cnt: 7 }];
          }
          return [];
        }),
        result = sessionEnd(
          { sqlJson, sqlRun, jsonErrNoExit, trustRecovery, runCompactCheap, runVacuum },
          { id: '10', memories: '5' },
        );
      expect(runCompactCheap).toHaveBeenCalled();
      expect(runVacuum).not.toHaveBeenCalled();
      expect(result.compacted.steps.vacuumed).toBeUndefined();
    });

    it('should not fail when runCompactCheap is not provided', () => {
      const sqlJson = vi.fn(),
        sqlRun = vi.fn(),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        trustRecovery = vi.fn(() => ({ ok: true })),
        result = sessionEnd({ sqlJson, sqlRun, jsonErrNoExit, trustRecovery }, { id: '10', memories: '5' });
      expect(result.ok).toBe(true);
      expect(result.compacted).toBeUndefined();
    });
  });
});
