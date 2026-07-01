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
