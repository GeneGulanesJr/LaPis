const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stateStore = require('../../src/claude-code/state-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-state-'));
}

describe('claude-code state-store', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('loadState returns defaults for a missing file', () => {
    const state = stateStore.loadState('nope', { dir });
    expect(state).toEqual(stateStore.defaultState());
    expect(state.sessionId).toBeNull();
    expect(state.editedFiles).toEqual([]);
  });

  test('loadState degrades to defaults on a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json', 'utf8');
    expect(stateStore.loadState('bad', { dir })).toEqual(stateStore.defaultState());
  });

  test('saveState round-trips all fields', () => {
    const state = {
      ...stateStore.defaultState(),
      sessionId: 42,
      currentProject: 'myproj',
      projectSessionCount: 3,
      memoriesSavedThisSession: 7,
      editedFiles: ['a.js', 'b.ts'],
      exploredFiles: ['c.js'],
      turnCount: 5,
      dreamTriggeredThisSession: false,
      lastMemoryToolCall: 1000,
      callsSinceLastMemory: 2,
      lastAutoDecisionSave: 2000,
      hasInjectedContext: true,
      pendingRecallFeedback: [[11, { sessionId: 42, query: 'q' }]],
      nativeChecked: true,
    };
    stateStore.saveState('s1', state, { dir });
    const loaded = stateStore.loadState('s1', { dir });
    expect(loaded.sessionId).toBe(42);
    expect(loaded.editedFiles).toEqual(['a.js', 'b.ts']);
    expect(loaded.pendingRecallFeedback).toEqual([[11, { sessionId: 42, query: 'q' }]]);
    expect(loaded.nativeChecked).toBe(true);
  });

  test('loadState merges onto defaults (forward-compatible fields)', () => {
    // An older state file missing newer fields still loads with defaults filled.
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ sessionId: 9 }), 'utf8');
    const loaded = stateStore.loadState('old', { dir });
    expect(loaded.sessionId).toBe(9);
    expect(loaded.editedFiles).toEqual([]);
    expect(loaded.turnCount).toBe(0);
  });

  test('atomic write leaves no .tmp file behind', () => {
    stateStore.saveState('s2', { ...stateStore.defaultState(), sessionId: 1 }, { dir });
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('separate claudeSessionIds get separate files (isolation)', () => {
    stateStore.saveState('aaa', { ...stateStore.defaultState(), sessionId: 1 }, { dir });
    stateStore.saveState('bbb', { ...stateStore.defaultState(), sessionId: 2 }, { dir });
    expect(stateStore.loadState('aaa', { dir }).sessionId).toBe(1);
    expect(stateStore.loadState('bbb', { dir }).sessionId).toBe(2);
  });

  test('clearState unlinks the file and is idempotent', () => {
    stateStore.saveState('s3', { ...stateStore.defaultState(), sessionId: 1 }, { dir });
    expect(fs.existsSync(path.join(dir, 's3.json'))).toBe(true);
    stateStore.clearState('s3', { dir });
    expect(fs.existsSync(path.join(dir, 's3.json'))).toBe(false);
    // Idempotent: clearing again does not throw.
    expect(() => stateStore.clearState('s3', { dir })).not.toThrow();
  });

  test('sweepStaleSessions removes files older than the threshold', () => {
    const fresh = { ...stateStore.defaultState(), sessionId: 1 };
    const stale = { ...stateStore.defaultState(), sessionId: 2 };
    stateStore.saveState('fresh', fresh, { dir });
    stateStore.saveState('stale', stale, { dir });

    // Backdate the stale file by 25h.
    const oldTime = new Date(Date.now() - 25 * 3600 * 1000).getTime() / 1000;
    fs.utimesSync(path.join(dir, 'stale.json'), oldTime, oldTime);

    const result = stateStore.sweepStaleSessions(24, { dir });
    expect(result.swept).toBe(1);
    expect(fs.existsSync(path.join(dir, 'stale.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'fresh.json'))).toBe(true);
  });
});

describe('claude-code state-store: unusable session_id (fail-open)', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sanitizeKey rejects missing/null/empty/placeholder ids', () => {
    expect(stateStore.sanitizeKey(undefined)).toBeNull();
    expect(stateStore.sanitizeKey(null)).toBeNull();
    expect(stateStore.sanitizeKey('')).toBeNull();
    expect(stateStore.sanitizeKey('   ')).toBeNull();
    expect(stateStore.sanitizeKey('undefined')).toBeNull();
    expect(stateStore.sanitizeKey('null')).toBeNull();
    // A real uuid is fine.
    expect(stateStore.sanitizeKey('a1b2-c3d4')).toBe('a1b2-c3d4');
  });

  test('loadState returns defaults (no file written) for an unusable id', () => {
    expect(stateStore.loadState(undefined, { dir })).toEqual(stateStore.defaultState());
    expect(stateStore.loadState(null, { dir })).toEqual(stateStore.defaultState());
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('saveState is a no-op for an unusable id (no shared undefined.json)', () => {
    expect(stateStore.saveState(undefined, { ...stateStore.defaultState(), sessionId: 9 }, { dir })).toBe(false);
    expect(stateStore.saveState(null, { ...stateStore.defaultState(), sessionId: 9 }, { dir })).toBe(false);
    expect(stateStore.saveState('', { ...stateStore.defaultState(), sessionId: 9 }, { dir })).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('clearState is a no-op for an unusable id', () => {
    expect(() => stateStore.clearState(undefined, { dir })).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('two distinct usable ids stay isolated', () => {
    stateStore.saveState('aaa', { ...stateStore.defaultState(), sessionId: 1 }, { dir });
    stateStore.saveState('bbb', { ...stateStore.defaultState(), sessionId: 2 }, { dir });
    expect(stateStore.loadState('aaa', { dir }).sessionId).toBe(1);
    expect(stateStore.loadState('bbb', { dir }).sessionId).toBe(2);
  });
});

describe('claude-code state-store: locked mutateState', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('mutateState load-modify-write round-trips and persists', async () => {
    stateStore.saveState('m1', { ...stateStore.defaultState(), memoriesSavedThisSession: 1 }, { dir });
    await stateStore.mutateState(
      'm1',
      (s) => {
        s.memoriesSavedThisSession += 1;
      },
      { dir },
    );
    expect(stateStore.loadState('m1', { dir }).memoriesSavedThisSession).toBe(2);
  });

  test('mutateState serializes concurrent increments (no lost update)', async () => {
    stateStore.saveState('m2', { ...stateStore.defaultState(), memoriesSavedThisSession: 0 }, { dir });
    const inc = () =>
      stateStore.mutateState(
        'm2',
        async (s) => {
          const before = s.memoriesSavedThisSession;
          // Simulate the read-compute gap that lost updates before the lock.
          await new Promise((r) => setTimeout(r, 5));
          s.memoriesSavedThisSession = before + 1;
        },
        { dir },
      );
    await Promise.all([inc(), inc(), inc(), inc(), inc()]);
    expect(stateStore.loadState('m2', { dir }).memoriesSavedThisSession).toBe(5);
  });

  test('mutateState leaves no stray .lock file behind', async () => {
    await stateStore.mutateState(
      'm3',
      (s) => {
        s.sessionId = 1;
      },
      { dir },
    );
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.lock'));
    expect(leftovers).toEqual([]);
  });

  test('mutateState on an unusable id runs the mutator against a transient state', async () => {
    let seen;
    const result = await stateStore.mutateState(
      undefined,
      (s) => {
        seen = s;
        return 'done';
      },
      { dir },
    );
    expect(result).toBe('done');
    expect(seen).toEqual(stateStore.defaultState());
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('claude-code state-store: TTL + gc', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.LAPIS_SESSION_TTL_HOURS;
  });

  test('defaultTtlHours honors LAPIS_SESSION_TTL_HOURS and falls back to 24', () => {
    expect(stateStore.defaultTtlHours()).toBe(24);
    process.env.LAPIS_SESSION_TTL_HOURS = '72';
    expect(stateStore.defaultTtlHours()).toBe(72);
    process.env.LAPIS_SESSION_TTL_HOURS = 'not-a-number';
    expect(stateStore.defaultTtlHours()).toBe(24);
  });

  test('sweepStaleSessions uses the env TTL by default', () => {
    stateStore.saveState('fresh', stateStore.defaultState(), { dir });
    stateStore.saveState('stale', stateStore.defaultState(), { dir });
    const oldTime = new Date(Date.now() - 30 * 3600 * 1000).getTime() / 1000;
    fs.utimesSync(path.join(dir, 'stale.json'), oldTime, oldTime);
    // 48h window → nothing swept.
    process.env.LAPIS_SESSION_TTL_HOURS = '48';
    expect(stateStore.sweepStaleSessions(undefined, { dir }).swept).toBe(0);
    // 24h default window → stale swept.
    delete process.env.LAPIS_SESSION_TTL_HOURS;
    fs.utimesSync(path.join(dir, 'stale.json'), oldTime, oldTime);
    expect(stateStore.sweepStaleSessions(undefined, { dir }).swept).toBe(1);
  });

  test('runGc sweeps and reports, honoring --max-age-hours', () => {
    stateStore.saveState('a', stateStore.defaultState(), { dir });
    stateStore.saveState('b', stateStore.defaultState(), { dir });
    const oldTime = new Date(Date.now() - 100 * 3600 * 1000).getTime() / 1000;
    fs.utimesSync(path.join(dir, 'b.json'), oldTime, oldTime);
    const lines = [];
    const result = stateStore.runGc(['--max-age-hours', '50'], { dir, log: (l) => lines.push(l) });
    expect(result.swept).toBe(1);
    expect(result.maxAgeHours).toBe(50);
    expect(lines.join('\n')).toContain('Swept 1');
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
  });

  test('runGc rejects unknown flags and invalid --max-age-hours', () => {
    expect(() => stateStore.runGc(['--bogus'], { dir, log: () => {} })).toThrow(/Unknown flag/);
    expect(() => stateStore.runGc(['--max-age-hours', '0'], { dir, log: () => {} })).toThrow(/positive number/);
  });
});
