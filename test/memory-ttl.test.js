const { parseExpiresIn, formatSqliteDatetime } = require('../src/memory-domain/ttl');
const obsService = require('../services/observations');
const obsDA = require('../data-access/observations');

function mockDeps(overrides = {}) {
  return {
    sqlJson: vi.fn(),
    sqlRun: vi.fn(),
    ...overrides,
  };
}

describe('memory-domain/ttl: parseExpiresIn', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(parseExpiresIn(null)).toBeNull();
    expect(parseExpiresIn(undefined)).toBeNull();
    expect(parseExpiresIn('')).toBeNull();
  });

  it('returns null for invalid formats', () => {
    expect(parseExpiresIn('foo')).toBeNull();
    expect(parseExpiresIn('7')).toBeNull();
    expect(parseExpiresIn('7x')).toBeNull();
    expect(parseExpiresIn('0d')).toBeNull();
    expect(parseExpiresIn('-1d')).toBeNull();
    expect(parseExpiresIn('abc7d')).toBeNull();
  });

  it('parses days', () => {
    const now = Date.now();
    const result = parseExpiresIn('7d');
    const parsed = Date.parse(result.replace(' ', 'T') + 'Z');
    const days = (parsed - now) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('parses weeks (1w = 7 days)', () => {
    const now = Date.now();
    const result = parseExpiresIn('2w');
    const parsed = Date.parse(result.replace(' ', 'T') + 'Z');
    const days = (parsed - now) / 86400000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('parses months (1m = 30 days)', () => {
    const now = Date.now();
    const result = parseExpiresIn('1m');
    const parsed = Date.parse(result.replace(' ', 'T') + 'Z');
    const days = (parsed - now) / 86400000;
    expect(days).toBeGreaterThan(29.5);
    expect(days).toBeLessThan(30.5);
  });

  it('parses hours', () => {
    const now = Date.now();
    const result = parseExpiresIn('12h');
    const parsed = Date.parse(result.replace(' ', 'T') + 'Z');
    const hours = (parsed - now) / 3600000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.1);
  });

  it('is case-insensitive', () => {
    expect(parseExpiresIn('7D')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('memory-domain/ttl: formatSqliteDatetime', () => {
  it('formats a Date as YYYY-MM-DD HH:MM:SS UTC', () => {
    const d = new Date(Date.UTC(2026, 5, 4, 12, 34, 56));
    expect(formatSqliteDatetime(d)).toBe('2026-06-04 12:34:56');
  });

  it('zero-pads month and day', () => {
    const d = new Date(Date.UTC(2026, 0, 5, 1, 2, 3));
    expect(formatSqliteDatetime(d)).toBe('2026-01-05 01:02:03');
  });
});

describe('services/observations: save with --expires-in', () => {
  it('rejects invalid expires-in', () => {
    const deps = {
      jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      insertObservation: vi.fn(),
      insertObservationRelation: vi.fn(),
      softDeleteObservation: vi.fn(),
      checkDuplicate: vi.fn(),
      findLatestSession: vi.fn(),
    };
    const result = obsService.save(deps, {
      title: 'T',
      content: 'C',
      'expires-in': 'not-a-duration',
    });
    expect(result.error).toContain('Invalid --expires-in');
    expect(deps.insertObservation).not.toHaveBeenCalled();
  });

  it('passes expiresAt to insertObservation when valid', () => {
    const insertObservation = vi.fn(() => [{ id: 1, created_at: '2025-01-01', expires_at: '2026-01-08 00:00:00' }]);
    const deps = {
      jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      insertObservation,
      insertObservationRelation: vi.fn(),
      softDeleteObservation: vi.fn(),
      checkDuplicate: vi.fn(() => ({ potential_duplicates: [] })),
      findLatestSession: vi.fn(() => '1'),
    };
    obsService.save(deps, {
      title: 'Workaround',
      content: 'For bug #123',
      'expires-in': '7d',
    });
    expect(insertObservation).toHaveBeenCalledTimes(1);
    const call = insertObservation.mock.calls[0][0];
    expect(call.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('passes null expiresAt when --expires-in is not provided', () => {
    const insertObservation = vi.fn(() => [{ id: 1, created_at: '2025-01-01' }]);
    const deps = {
      jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      insertObservation,
      insertObservationRelation: vi.fn(),
      softDeleteObservation: vi.fn(),
      checkDuplicate: vi.fn(() => ({ potential_duplicates: [] })),
      findLatestSession: vi.fn(() => '1'),
    };
    obsService.save(deps, { title: 'T', content: 'C' });
    const call = insertObservation.mock.calls[0][0];
    expect(call.expiresAt).toBeNull();
  });

  it('accepts expiresIn camelCase as well', () => {
    const insertObservation = vi.fn(() => [{ id: 1, created_at: '2025-01-01' }]);
    const deps = {
      jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
      insertObservation,
      insertObservationRelation: vi.fn(),
      softDeleteObservation: vi.fn(),
      checkDuplicate: vi.fn(() => ({ potential_duplicates: [] })),
      findLatestSession: vi.fn(() => '1'),
    };
    obsService.save(deps, { title: 'T', content: 'C', expiresIn: '1d' });
    const call = insertObservation.mock.calls[0][0];
    expect(call.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('data-access/observations: expires_at column', () => {
  it('insertObservation includes expires_at in INSERT', () => {
    const deps = mockDeps();
    deps.sqlJson.mockReturnValue([{ id: 1, created_at: '2025-01-01', expires_at: null }]);
    obsDA.insertObservation(deps, {
      sessionId: '1',
      type: 'manual',
      title: 'T',
      content: 'C',
      project: 'p',
      scope: 'project',
      topicKey: null,
      expiresAt: '2026-12-31 00:00:00',
    });
    const [sql, params] = deps.sqlJson.mock.calls[0];
    expect(sql).toContain('expires_at');
    expect(params).toContain('2026-12-31 00:00:00');
  });

  it('insertObservation with no expiresAt inserts NULL', () => {
    const deps = mockDeps();
    deps.sqlJson.mockReturnValue([{ id: 1, created_at: '2025-01-01' }]);
    obsDA.insertObservation(deps, {
      sessionId: '1',
      type: 'manual',
      title: 'T',
      content: 'C',
      project: 'p',
      scope: 'project',
      topicKey: null,
    });
    const params = deps.sqlJson.mock.calls[0][1];
    expect(params[params.length - 1]).toBeNull();
  });

  it('getObservation selects expires_at', () => {
    const deps = mockDeps();
    deps.sqlJson.mockReturnValue([{ id: 1, expires_at: '2026-12-31 00:00:00' }]);
    obsDA.getObservation(deps, 1);
    const sql = deps.sqlJson.mock.calls[0][0];
    expect(sql).toContain('expires_at');
  });
});

describe('data-access/observations: updateObservation with expiry', () => {
  it('sets expires_at when expiresAt provided', () => {
    const deps = mockDeps();
    deps.sqlJson
      .mockReturnValueOnce([{ id: 1, title: 'T', content: 'C', type: 'manual', scope: 'project', expires_at: null }])
      .mockReturnValueOnce([{ id: 1, title: 'T', content: 'C', expires_at: '2026-12-31 00:00:00' }]);
    obsDA.updateObservation(deps, { id: 1, expiresAt: '2026-12-31 00:00:00' });
    const updateCall = deps.sqlRun.mock.calls.find((c) => c[0].startsWith('UPDATE'));
    expect(updateCall[0]).toContain('expires_at = ?');
    expect(updateCall[1]).toContain('2026-12-31 00:00:00');
  });

  it('clears expires_at when clearExpiry is true', () => {
    const deps = mockDeps();
    deps.sqlJson
      .mockReturnValueOnce([
        { id: 1, title: 'T', content: 'C', type: 'manual', scope: 'project', expires_at: '2026-12-31 00:00:00' },
      ])
      .mockReturnValueOnce([{ id: 1, title: 'T', content: 'C', expires_at: null }]);
    obsDA.updateObservation(deps, { id: 1, clearExpiry: true });
    const updateCall = deps.sqlRun.mock.calls.find((c) => c[0].startsWith('UPDATE'));
    expect(updateCall[0]).toContain('expires_at = ?');
    expect(updateCall[1]).toContain(null);
  });

  it('records expiry change in observation_versions', () => {
    const deps = mockDeps();
    deps.sqlJson
      .mockReturnValueOnce([
        { id: 1, title: 'T', content: 'C', type: 'manual', scope: 'project', expires_at: '2025-01-01 00:00:00' },
      ])
      .mockReturnValueOnce([{ id: 1, title: 'T', content: 'C' }]);
    obsDA.updateObservation(deps, { id: 1, expiresAt: '2026-12-31 00:00:00' });
    const versionCall = deps.sqlRun.mock.calls.find((c) => c[0].includes('observation_versions'));
    expect(versionCall).toBeDefined();
    expect(versionCall[1]).toContain('expires_at');
  });

  it('records clearExpiry as an expires_at version row', () => {
    const deps = mockDeps();
    deps.sqlJson
      .mockReturnValueOnce([
        { id: 1, title: 'T', content: 'C', type: 'manual', scope: 'project', expires_at: '2026-12-31 00:00:00' },
      ])
      .mockReturnValueOnce([{ id: 1, title: 'T', content: 'C', expires_at: null }]);
    obsDA.updateObservation(deps, { id: 1, clearExpiry: true });
    const versionCall = deps.sqlRun.mock.calls.find((c) => c[0].includes('observation_versions'));
    expect(versionCall).toBeDefined();
    expect(versionCall[1]).toContain('expires_at');
    // old_value is the prior date; new_value uses '' (NOT NULL convention)
    // because observation_versions.new_value is TEXT NOT NULL.
    expect(versionCall[1]).toContain('2026-12-31 00:00:00');
    expect(versionCall[1]).toContain('');
  });
});

describe('compaction: runCompact expires expired observations', () => {
  it('hard-deletes expired observations', () => {
    const result = (() => {
      const deps = {
        sqlRun: vi.fn(),
        sqlRaw: vi.fn(),
      };
      const { runCompact } = require('../src/memory-domain/compaction');
      return runCompact(deps);
    })();
    const expiredCall = result.steps.expiredPurged;
    expect(expiredCall).toBe(true);
  });

  it('emits the expired purge SQL as the first cleanup step', () => {
    const sqlRun = vi.fn();
    const sqlRaw = vi.fn();
    const { runCompact } = require('../src/memory-domain/compaction');
    runCompact({ sqlRun, sqlRaw });
    const firstNonFtsRun = sqlRun.mock.calls[0];
    expect(firstNonFtsRun[0]).toContain('expires_at');
    expect(firstNonFtsRun[0]).toContain("datetime('now')");
  });
});

// Schema migration tests are skipped by default — they require a working libSQL
// backend (npm install). They are kept commented for the project maintainers.
//
// describe('schema migration V17', () => {
//   it('adds expires_at column to observations', () => { ... });
//   it('creates partial index on expires_at', () => { ... });
// });
