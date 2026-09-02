const { runCompact, compact, dream, trustRecovery } = require('../services/dream'), dbModule = require('../db');


describe('services/dream: runCompact', () => {
  beforeAll(() => {
    dbModule.ensureDb();
  });

  it('should return ok: true on success', () => {
    const result = runCompact();
    expect(result.ok).toBe(true);
  });

  it('should return steps with expected cleanup operations', () => {
    const result = runCompact();
    expect(result.steps).toBeDefined();
    expect(result.steps.deadLinksCleaned).toBe(true);
    expect(result.steps.purgedSoftDeleted).toBe(true);
    expect(result.steps.oldSummariesPruned).toBe(true);
    expect(result.steps.staleTrustDecayed).toBe(true);
    expect(result.steps.vacuumed).toBe(true);
    expect(result.steps.ftsOptimized).toBe(true);
  });

  it('should include startedAt and completedAt timestamps', () => {
    const result = runCompact();
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
  });
});

describe('services/dream: compact', () => {
  it('should delegate to runCompact', () => {
    const result = compact();
    expect(result.ok).toBe(true);
    expect(result.steps).toBeDefined();
  });
});

describe('services/dream: trustRecovery', () => {
  let sessionId;

  beforeAll(() => {
    dbModule.ensureDb();
    const sessionResult = dbModule.sqlJson(
      "INSERT INTO session_log (project, started_at) VALUES (?, datetime('now')) RETURNING id",
      ['test-trust-recovery'],
    );
    sessionId = sessionResult[0].id;
  });

  it('should require session parameter', () => {
    const result = trustRecovery({});
    expect(result.error).toBeDefined();
  });

  it('should return ok: true and memoriesRecovered count', () => {
    const result = trustRecovery({ session: String(sessionId) });
    expect(result.ok).toBe(true);
    expect(typeof result.memoriesRecovered).toBe('number');
  });
});

describe('services/dream: dream', () => {
  it('should run dream phases and return a report', () => {
    const deps = {
        sqlJson: vi.fn(() => []),
        sqlRun: vi.fn(),
        softDeleteObservation: vi.fn(),
      },
      result = dream(deps);
    expect(result.ok).toBe(true);
    expect(result.phases).toBeDefined();
    expect(result.totalCleaned).toBeDefined();
    expect(typeof result.totalCleaned).toBe('number');
  });

  it('should supersede duplicate memories in phase 1', () => {
    const supersededRows = [
        {
          id: 10,
          title: 'Duplicate entry',
          type: 'decision',
          project: 'proj',
          newer_id: 20,
          relation: 'duplicate',
          confidence: 0.95,
        },
      ],
      deps = {
        sqlJson: vi.fn(() => []),
        sqlRun: vi.fn(),
        softDeleteObservation: vi.fn(),
      };
    let callCount = 0;
    deps.sqlJson = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return supersededRows;
      }
      return [];
    });
    const result = dream(deps);
    expect(deps.softDeleteObservation).toHaveBeenCalledWith(10);
    expect(result.phases.superseded.count).toBe(1);
  });
});
