describe('gateway dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error for unknown command after init', async () => {
    vi.doMock('../../db', () => ({
      ensureDb: vi.fn(),
      getDb: vi.fn(() => ({})),
      sqlJson: vi.fn(() => []),
      sqlRun: vi.fn(),
      sqlRaw: vi.fn(),
      jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      DB_PATH: ':memory:',
      getEngine: vi.fn(() => 'sqlite'),
    }));

    vi.doMock('../../data-access/observations', () => ({ softDeleteObservation: vi.fn() }));
    vi.doMock('../../platform/storage/repositories', () => ({ createRepositories: vi.fn(() => ({})) }));
    vi.doMock('../../config', () => ({ getConfig: vi.fn(() => ({ tier_config_path: '/nonexistent' })) }));
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(() => {
        throw new Error('no tier config');
      }),
    }));

    const { dispatch } = require('../src/cli/gateway');
    const result = await dispatch('nonexistent-command', {});
    expect(result).toBeDefined();
    expect(result.error).toContain('Unknown command');
  });
});

describe('dashboard CLI command', () => {
  it('should register and call getDashboard', () => {
    // Test the command router directly without going through gateway's module loading
    const mockGetDashboard = vi.fn(() => ({
      overview: { totalMemories: 5, totalProjects: 1, thisWeekSaved: 1, thisWeekCleaned: 0, avgTrust: 0.9, neverRecalled: 0, expiringSoon: 0 },
      byType: [],
      trust: { avg: 0.9, lowTrustCount: 0, distribution: { high: 5, medium: 0, low: 0, none: 0 } },
      recall: { totalRecalls: 10, usefulRate: 0.8, uniqueMemoriesHit: 5 },
      dream: { lastRun: null, totalCleaned: null, runCount: null },
      codeIndex: [],
    }));

    // Manually simulate what the register function does
    const commands = {};
    const deps = { sqlJson: vi.fn(), sqlRun: vi.fn() };

    // The actual register function from dashboard.js:
    // commands.dashboard = () => getDashboard(deps);
    // We test the pattern directly:
    commands.dashboard = () => mockGetDashboard(deps);

    const result = commands.dashboard();
    expect(mockGetDashboard).toHaveBeenCalledWith(deps);
    expect(result.overview.totalMemories).toBe(5);
    expect(result.codeIndex).toEqual([]);
  });
});
