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
  it('purges legacy __unlinked__ rows before linking, and reports what is left', () => {
    const { autoLink } = require('../src/trust-sync/symbol-links'),
      calls = [],
      repository = {
        deletePlaceholderLinks: (project) => calls.push(['purge', project]),
        autoLinkMemories: (repo) => (calls.push(['link', repo]), { total: 2, linked: 1, links: 3 }),
      },
      deps = { jsonErrNoExit: (m) => ({ error: m }), trustSyncRepository: repository };
    const result = autoLink(deps, { project: 'demo' });
    expect(result).toMatchObject({ ok: true, linked: 1, links: 3, total: 2 });
    expect(result.message).toContain('Linked 1 of 2');
    expect(calls).toEqual([
      ['purge', 'demo'],
      ['link', 'demo'],
    ]);
  });

  it('links memories to the indexed files and unique symbols they mention', () => {
    const dbModule = require('../db'),
      symbols = require('../data-access/symbols');
    dbModule.ensureDb();
    const root = path.join(os.tmpdir(), 'al-link-repo');
    dbModule.sqlRun('INSERT INTO code_repos (name, path) VALUES (?, ?)', ['al-link', root]);
    const repoId = dbModule.sqlJson("SELECT id FROM code_repos WHERE name = 'al-link'")[0].id,
      addFile = (rel) => {
        const abs = path.join(root, rel);
        dbModule.sqlRun(
          "INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, 'javascript', '', 'h')",
          [repoId, abs],
        );
        return { abs, id: dbModule.sqlJson('SELECT id FROM code_files WHERE path = ?', [abs])[0].id };
      },
      addSymbol = (file, name) =>
        dbModule.sqlRun(
          `INSERT INTO code_symbols (repo_id, file_id, name, kind, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name)
           VALUES (?, ?, ?, 'function', ?, 1, 2, 0, 10, 'javascript', ?)`,
          [repoId, file.id, name, file.abs, name],
        ),
      ctx = addFile('src/memory-domain/context.js'),
      a = addFile('src/a.js'),
      b = addFile('src/b.js');
    addSymbol(ctx, 'topicQueryNeedles');
    addSymbol(a, 'sharedHelper');
    addSymbol(b, 'sharedHelper');
    const save = (title, content) =>
      dbModule.sqlRun(
        "INSERT INTO observations (session_id, type, title, content, project) VALUES ('t', 'decision', ?, ?, 'AL-LINK')",
        [title, content],
      );
    save('Needle window', '**Where**: memory-domain/context.js (`topicQueryNeedles`), also sharedHelper');
    save('Plain words', 'Nothing here names any code at all.');

    expect(symbols.autoLinkMemories(dbModule, 'al-link')).toEqual({ total: 2, linked: 1, links: 2 });
    const rows = dbModule.sqlJson(
      "SELECT symbol_id, symbol_path, trust_score, repo FROM symbol_links WHERE repo = 'al-link' ORDER BY symbol_id",
    );
    // The path mention and the unique name link; a name defined in two files is ambiguous and does not.
    expect(rows).toEqual([
      { symbol_id: 'src/memory-domain/context.js', symbol_path: ctx.abs, trust_score: 1, repo: 'al-link' },
      { symbol_id: 'topicQueryNeedles', symbol_path: ctx.abs, trust_score: 1, repo: 'al-link' },
    ]);
    // A second run only retries the memory that is still unlinked.
    expect(symbols.autoLinkMemories(dbModule, 'al-link')).toEqual({ total: 1, linked: 0, links: 0 });
    dbModule.sqlRun("DELETE FROM symbol_links WHERE repo = 'al-link'");
    dbModule.sqlRun("DELETE FROM observations WHERE project = 'AL-LINK'");
    dbModule.sqlRun("DELETE FROM code_repos WHERE name = 'al-link'");
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
