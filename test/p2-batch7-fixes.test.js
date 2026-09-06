// Regression tests for review batch 7: #296 (hermes saveState locking),
// #300 (exact vs fuzzy trust matching), #301 (autoLink placeholder rows),
// #302 (tier config string-aware JSONC + fail closed). Isolated temp DB.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-p2-batch7-'));

describe('#296 hermes saveState runs under a lock and survives stale locks', () => {
  const stateStore = require('../src/hermes/state-store'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-hermes-lock-'));

  it('merges patches and leaves no lock directory behind', () => {
    stateStore.saveState(dir, 'sess-1', { lapisSessionId: 42 });
    stateStore.saveState(dir, 'sess-1', { turnCount: 3 });
    const state = stateStore.loadState(dir, 'sess-1');
    expect(state.lapisSessionId).toBe(42);
    expect(state.turnCount).toBe(3);
    expect(fs.existsSync(path.join(dir, 'sess-1.json.lock'))).toBe(false);
  });

  it('breaks a stale lock left by a crashed holder', () => {
    const lockDir = path.join(dir, 'stale.json.lock');
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockDir, old, old);
    expect(() => stateStore.saveState(dir, 'stale', { ok: true })).not.toThrow();
    expect(stateStore.loadState(dir, 'stale').ok).toBe(true);
  });
});

describe('#301 autoLink stops writing placeholder links', () => {
  it('purges legacy __unlinked__ rows and never inserts new ones', () => {
    const { autoLink } = require('../src/trust-sync/symbol-links'),
      calls = { deletePlaceholderLinks: [], insertSymbolLink: [] },
      repository = {
        findUnlinked: () => [{ memory_id: 'm1' }, { memory_id: 'm2' }],
        deletePlaceholderLinks: (project) => calls.deletePlaceholderLinks.push(project),
        insertSymbolLink: (params) => calls.insertSymbolLink.push(params),
      },
      deps = {
        sqlRun: () => {},
        jsonErrNoExit: (m) => ({ error: m }),
        trustSyncRepository: repository,
      };
    const result = autoLink(deps, { project: 'demo' });
    expect(result.ok).toBe(true);
    expect(result.linked).toBe(0);
    expect(result.total).toBe(2);
    expect(result.message).toContain('2 memories');
    expect(calls.deletePlaceholderLinks).toEqual(['demo']);
    expect(calls.insertSymbolLink).toHaveLength(0);
  });

  it('real placeholder rows no longer hide a memory from findUnlinked after the purge', () => {
    const dbModule = require('../db'),
      symbols = require('../data-access/symbols');
    dbModule.ensureDb();
    dbModule.sqlRun(
      "INSERT INTO observations (session_id, type, title, content, project) VALUES ('t', 'decision', 'unlinked one', 'c', 'al-demo')",
    );
    const memoryId = dbModule.sqlJson("SELECT id FROM observations WHERE project = 'al-demo'")[0].id;
    dbModule.sqlRun("INSERT INTO symbol_links (memory_id, symbol_id, repo) VALUES (?, '__unlinked__', 'al-demo')", [
      String(memoryId),
    ]);

    // Before the purge the placeholder row hides the memory…
    const before = symbols.findUnlinked(dbModule, 'al-demo');
    expect(before.some((r) => String(r.memory_id) === String(memoryId))).toBe(false);

    symbols.deletePlaceholderLinks(dbModule, 'al-demo');
    const after = symbols.findUnlinked(dbModule, 'al-demo');
    expect(after.some((r) => String(r.memory_id) === String(memoryId))).toBe(true);
    dbModule.sqlRun('DELETE FROM symbol_links WHERE repo = ?', ['al-demo']);
    dbModule.sqlRun('DELETE FROM observations WHERE project = ?', ['al-demo']);
  });
});

describe('#302 tier config is string-aware and fails closed', () => {
  const home = path.join(process.env.LAPIS_HOME, '.pi', 'memory'),
    tierFile = path.join(home, 'tier.jsonc'),
    { readTierConfig } = require('../config');

  function writeTier(content) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(tierFile, content);
  }

  it('keeps the unrestricted default when no tier file exists', () => {
    fs.rmSync(tierFile, { force: true });
    expect(readTierConfig()).toEqual({ tier: 'full' });
  });

  it('parses a valid tier whose strings contain // (the old regex truncated these)', () => {
    writeTier('{ "tier": "standard", "note": "see https://example.com/docs" }');
    expect(readTierConfig()).toEqual({ tier: 'standard' });
  });

  it('supports JSONC comments', () => {
    writeTier('{\n // stricter for launch\n "tier": "core"\n}');
    expect(readTierConfig()).toEqual({ tier: 'core' });
  });

  it('fails closed on invalid JSON', () => {
    writeTier('{ "tier": "full"'); // truncated
    expect(readTierConfig()).toEqual({ tier: 'core' });
  });

  it('fails closed on an unknown tier name', () => {
    writeTier('{ "tier": "totally-unrestricted" }');
    expect(readTierConfig()).toEqual({ tier: 'core' });
  });
});
