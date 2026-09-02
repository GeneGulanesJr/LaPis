// Test/hermes/state-store.test.js
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { loadState, saveState, statePath } = require('../../src/hermes/state-store');

describe('hermes state-store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-hermes-state-'));
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(root, 'sessions-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('statePath namespaces per session id (never collapses to one file)', () => {
    expect(statePath(dir, 'sess-1')).not.toBe(statePath(dir, 'sess-2'));
    expect(statePath(dir, 'sess-1')).toContain('sess-1');
  });

  test('save then load round-trips', () => {
    saveState(dir, 'sess-1', { lapisSessionId: 42, turnCount: 3 });
    expect(loadState(dir, 'sess-1')).toMatchObject({ lapisSessionId: 42, turnCount: 3 });
  });

  test('missing/placeholder session id → defaults, no file written', () => {
    for (const bad of [undefined, null, '', 'None', 'none']) {
      expect(loadState(dir, bad)).toEqual({});
      saveState(dir, bad, { lapisSessionId: 1 }); // Must not throw or write
    }
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  test('corrupt file degrades to defaults', () => {
    fs.writeFileSync(statePath(dir, 'bad'), '{not json');
    expect(loadState(dir, 'bad')).toEqual({});
  });

  test('saveState merges onto existing state (counter increments survive)', () => {
    saveState(dir, 'sess-3', { turnCount: 1 });
    saveState(dir, 'sess-3', { turnCount: 2, editedFiles: ['a.js'] });
    expect(loadState(dir, 'sess-3')).toMatchObject({ turnCount: 2, editedFiles: ['a.js'] });
  });
});
