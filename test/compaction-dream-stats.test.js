describe('dream cycle stats persistence', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should persist dream stats to settings on successful dream', () => {
    const sqlJsonCalls = [];
    const sqlRunCalls = [];
    const deps = {
      sqlJson: vi.fn((query, params) => {
        sqlJsonCalls.push({ query, params });
        if (typeof query === 'string') {
          if (query.includes('observations WHERE expires_at')) return [{ cnt: 0 }];
          if (query.includes('superseded') && query.includes('observation_relation')) return [];
          if (query.includes('type = ?') && query.includes('stale')) return [];
          if (query.includes('Auto-detected')) return [];
          if (query.includes('CORRECTION') || query.includes('Correction')) return [];
          if (query.includes('replaced config') || query.includes('obsolete')) return [];
          if (query.includes('noise') || query.includes('low-value')) return [];
          if (query.includes('topic_key') && query.includes('GROUP BY') && query.includes('HAVING')) return [];
          if (query.includes('dream_total_cleaned')) return [{ value: '10' }];
          if (query.includes('dream_run_count')) return [{ value: '2' }];
        }
        return [];
      }),
      sqlRun: vi.fn((query, params) => {
        sqlRunCalls.push({ query, params });
      }),
      sqlRaw: vi.fn(),
      softDeleteObservation: vi.fn(),
    };

    const { dream } = require('../src/memory-domain/compaction');
    const report = dream(deps);

    expect(report.ok).toBe(true);
    const settingsWrites = sqlRunCalls.filter((c) => c.query.includes('settings'));
    expect(settingsWrites).toHaveLength(3);
    expect(settingsWrites[0].query).toContain('dream_last_run');
    expect(settingsWrites[1].query).toContain('dream_total_cleaned');
    expect(settingsWrites[1].params[0]).toBe('10'); // previous 10 + 0 cleaned
    expect(settingsWrites[2].query).toContain('dream_run_count');
    expect(settingsWrites[2].params[0]).toBe('3'); // previous 2 + 1
  });

  it('should NOT persist dream stats when dream fails', () => {
    const sqlRunCalls = [];
    const deps = {
      sqlJson: vi.fn(() => {
        throw new Error('DB error');
      }),
      sqlRun: vi.fn((query, params) => {
        sqlRunCalls.push({ query, params });
      }),
      sqlRaw: vi.fn(),
      softDeleteObservation: vi.fn(),
    };

    const { dream } = require('../src/memory-domain/compaction');
    let report;
    try {
      report = dream(deps);
    } catch (e) {
      // dream() has no top-level try/catch, so errors propagate
      report = { ok: false, error: e.message };
    }

    expect(report.ok).toBe(false);
    const settingsWrites = sqlRunCalls.filter((c) => c.query.includes('settings'));
    expect(settingsWrites).toHaveLength(0);
  });
});
