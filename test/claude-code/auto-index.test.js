const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  realStateStore = require('../../src/claude-code/state-store'),
  {
    maybeStartAutoIndex,
    describeAutoIndex,
    findRepoRoot,
    markerFile,
    COOLDOWN_MS,
    IN_PROGRESS_MS,
  } = require('../../src/claude-code/auto-index'),
  { handlePreToolUse } = require('../../src/claude-code/handlers/pre-tool-use'),
  { handleSessionStart } = require('../../src/claude-code/handlers/session-start'),
  { applyEnvOverrides, DEFAULTS } = require('../../config'),
  ENABLED = { auto_index: { enabled: true } };

let tmp, repo, markerDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-autoindex-'));
  repo = path.join(tmp, 'myrepo');
  markerDir = path.join(tmp, 'markers');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeSpawn(pid = 4242) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return { pid };
  };
  fn.calls = calls;
  return fn;
}

function start(overrides = {}) {
  return maybeStartAutoIndex({
    cwd: repo,
    repos: [],
    config: ENABLED,
    dir: markerDir,
    spawnIndex: fakeSpawn(),
    isAlive: () => false,
    ...overrides,
  });
}

function makeStateStore() {
  const map = new Map();
  return {
    defaultState: realStateStore.defaultState,
    loadState: (id) => map.get(id) || realStateStore.defaultState(),
    saveState: (id, s) => map.set(id, s),
    mutateState: async (id, mutator) => {
      const s = map.get(id) || realStateStore.defaultState(),
        r = await mutator(s);
      map.set(id, s);
      return r;
    },
    clearStateLocked: async (id) => map.delete(id),
    sweepStaleSessions: () => ({ swept: 0 }),
  };
}

describe('auto-index: findRepoRoot', () => {
  test('finds the git root from a nested directory', () => {
    expect(findRepoRoot(path.join(repo, 'src', 'deep'))).toBe(repo);
  });

  test('accepts a .git file (worktree / submodule)', () => {
    const wt = path.join(tmp, 'worktree');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere');
    expect(findRepoRoot(wt)).toBe(wt);
  });

  test('returns null outside a git work tree', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(findRepoRoot(plain)).toBeNull();
  });

  test('never treats $HOME as a repo root even when it has a .git', () => {
    const home = path.join(tmp, 'home'),
      proj = path.join(home, 'notes');
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    fs.mkdirSync(proj);
    expect(findRepoRoot(proj, { HOME: home })).toBeNull();
  });
});

describe('auto-index: maybeStartAutoIndex', () => {
  test('starts a detached index for an unindexed git repo', () => {
    const spawnIndex = fakeSpawn(777),
      result = start({ spawnIndex });
    expect(result.status).toBe('started');
    expect(result.pid).toBe(777);
    expect(result.repoRoot).toBe(repo);
    expect(result.name).toBe('myrepo');
    expect(spawnIndex.calls).toHaveLength(1);
    expect(spawnIndex.calls[0]).toMatchObject({ repoRoot: repo, name: 'myrepo' });
    expect(JSON.parse(fs.readFileSync(markerFile(markerDir, repo), 'utf8')).pid).toBe(777);
  });

  test('starts from a subdirectory using the repo root', () => {
    const spawnIndex = fakeSpawn(),
      result = start({ cwd: path.join(repo, 'src', 'deep'), spawnIndex });
    expect(result.status).toBe('started');
    expect(spawnIndex.calls[0].repoRoot).toBe(repo);
  });

  test('does nothing when disabled', () => {
    const spawnIndex = fakeSpawn();
    expect(start({ config: { auto_index: { enabled: false } }, spawnIndex }).status).toBe('disabled');
    expect(spawnIndex.calls).toHaveLength(0);
  });

  test('does nothing for an already-indexed repo (path match)', () => {
    const spawnIndex = fakeSpawn();
    expect(start({ repos: [{ name: 'other', path: repo }], spawnIndex }).status).toBe('indexed');
    expect(spawnIndex.calls).toHaveLength(0);
  });

  test('does nothing when an indexed repo already owns the name', () => {
    const spawnIndex = fakeSpawn();
    expect(start({ repos: [{ name: 'MyRepo', path: '/elsewhere/myrepo' }], spawnIndex }).status).toBe('indexed');
    expect(spawnIndex.calls).toHaveLength(0);
  });

  test('does nothing outside a git repo', () => {
    const plain = path.join(tmp, 'plain'),
      spawnIndex = fakeSpawn();
    fs.mkdirSync(plain);
    expect(start({ cwd: plain, spawnIndex }).status).toBe('not-a-repo');
    expect(spawnIndex.calls).toHaveLength(0);
  });

  test('a live indexer is reported in-progress and not respawned', () => {
    const spawnIndex = fakeSpawn();
    expect(start({ spawnIndex }).status).toBe('started');
    const again = start({ spawnIndex, isAlive: () => true, now: Date.now() + IN_PROGRESS_MS - 1000 });
    expect(again.status).toBe('in-progress');
    expect(spawnIndex.calls).toHaveLength(1);
  });

  test('a dead indexer inside the cooldown is not respawned', () => {
    const spawnIndex = fakeSpawn(),
      t0 = Date.now();
    expect(start({ spawnIndex, now: t0 }).status).toBe('started');
    expect(start({ spawnIndex, now: t0 + 1000 }).status).toBe('cooldown');
    expect(spawnIndex.calls).toHaveLength(1);
  });

  test('retries once the cooldown has elapsed', () => {
    const spawnIndex = fakeSpawn(),
      t0 = Date.now();
    start({ spawnIndex, now: t0 });
    expect(start({ spawnIndex, now: t0 + COOLDOWN_MS + 1 }).status).toBe('started');
    expect(spawnIndex.calls).toHaveLength(2);
  });

  test('a marker claimed by another hook (no pid yet) counts as in-progress', () => {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile(markerDir, repo), JSON.stringify({ pid: null, startedAt: Date.now(), repoRoot: repo }));
    const spawnIndex = fakeSpawn();
    expect(start({ spawnIndex }).status).toBe('in-progress');
    expect(spawnIndex.calls).toHaveLength(0);
  });

  test('a spawn failure returns error and is not retried inside the cooldown', () => {
    const boom = () => {
        throw new Error('spawn ENOENT');
      },
      t0 = Date.now(),
      spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(start({ spawnIndex: boom, now: t0 }).status).toBe('error');
    } finally {
      spy.mockRestore();
    }
    const spawnIndex = fakeSpawn();
    expect(start({ spawnIndex, now: t0 + 1000 }).status).toBe('cooldown');
    expect(spawnIndex.calls).toHaveLength(0);
  });
});

describe('auto-index: describeAutoIndex', () => {
  const base = { repoRoot: '/r/app', name: 'app', logFile: '/log/app.log' };

  test('started / in-progress explain the wait and point at the log', () => {
    expect(describeAutoIndex({ ...base, status: 'started' })).toContain('Auto-indexing started');
    expect(describeAutoIndex({ ...base, status: 'in-progress' })).toContain('/log/app.log');
  });

  test('cooldown / error give the manual index command', () => {
    for (const status of ['cooldown', 'error']) {
      expect(describeAutoIndex({ ...base, status })).toContain('memory-code index-repo --path /r/app --name app');
    }
  });

  test('says nothing for indexed / disabled / not-a-repo', () => {
    for (const status of ['indexed', 'disabled', 'not-a-repo']) {
      expect(describeAutoIndex({ status })).toBeNull();
    }
  });
});

describe('auto-index: PreToolUse integration', () => {
  const call = (autoIndex, repos, tool_name = 'Grep', tool_input = { pattern: 'foo.*bar' }) =>
    handlePreToolUse({
      payload: { session_id: 's', tool_name, tool_input, cwd: repo },
      getKnownRepos: () => repos,
      stateStore: makeStateStore(),
      autoIndex,
    });

  test('an allowed call in an unindexed repo starts the index and tells the agent', async () => {
    const autoIndex = vi.fn(() => ({ status: 'started', repoRoot: repo, name: 'myrepo', logFile: '/l.log' })),
      out = await call(autoIndex, []);
    expect(autoIndex).toHaveBeenCalledTimes(1);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('Auto-indexing started');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test('stays silent when the index was already running', async () => {
    const autoIndex = () => ({ status: 'in-progress', repoRoot: repo, name: 'myrepo', logFile: '/l.log' });
    expect(await call(autoIndex, [])).toBeNull();
  });

  test('an indexed repo is still guarded and never triggers auto-index', async () => {
    const autoIndex = vi.fn(),
      out = await call(autoIndex, [{ name: 'myrepo', path: repo, indexed_at: new Date().toISOString() }]);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(autoIndex).not.toHaveBeenCalled();
  });

  test('an allowed call in an indexed repo does not call auto-index either', async () => {
    const autoIndex = vi.fn(),
      out = await call(autoIndex, [{ name: 'myrepo', path: repo }], 'Read', { file_path: 'package.json' });
    expect(out).toBeNull();
    expect(autoIndex).not.toHaveBeenCalled();
  });

  test('an auto-index crash never affects the tool call', async () => {
    const autoIndex = () => {
      throw new Error('boom');
    };
    expect(await call(autoIndex, [])).toBeNull();
  });
});

describe('auto-index: SessionStart integration', () => {
  const run = (autoIndex, extra = {}) =>
    handleSessionStart({
      payload: { session_id: 'c1', source: 'startup', cwd: repo },
      dispatch: async (cmd) => (cmd === 'session-start' ? { sessionId: 1, sessionCount: 1 } : { ok: true }),
      getKnownRepos: () => [],
      stateStore: makeStateStore(),
      autoIndex,
      ...extra,
    });

  test('appends the auto-index note to the injected context', async () => {
    const autoIndex = vi.fn(() => ({ status: 'started', repoRoot: repo, name: 'myrepo', logFile: '/l.log' })),
      out = await run(autoIndex);
    expect(autoIndex).toHaveBeenCalledWith(expect.objectContaining({ cwd: path.resolve(repo), repos: [] }));
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('was not indexed');
  });

  test('an auto-index crash never breaks SessionStart', async () => {
    const out = await run(() => {
      throw new Error('boom');
    });
    expect(out === null || out.hookSpecificOutput.hookEventName === 'SessionStart').toBe(true);
  });
});

describe('auto-index: config', () => {
  const withEnv = (value, fn) => {
    const prev = process.env.LAPIS_AUTO_INDEX;
    if (value === undefined) {
      delete process.env.LAPIS_AUTO_INDEX;
    } else {
      process.env.LAPIS_AUTO_INDEX = value;
    }
    try {
      return fn();
    } finally {
      if (prev === undefined) {
        delete process.env.LAPIS_AUTO_INDEX;
      } else {
        process.env.LAPIS_AUTO_INDEX = prev;
      }
    }
  };

  test('defaults to enabled', () => {
    expect(DEFAULTS.auto_index.enabled).toBe(true);
  });

  test.each(['0', 'false', 'OFF', 'no'])('LAPIS_AUTO_INDEX=%s disables it', (v) => {
    const cfg = structuredClone(DEFAULTS);
    withEnv(v, () => applyEnvOverrides(cfg));
    expect(cfg.auto_index.enabled).toBe(false);
  });

  test('LAPIS_AUTO_INDEX=1 re-enables over a disabled config', () => {
    const cfg = { ...structuredClone(DEFAULTS), auto_index: { enabled: false } };
    withEnv('1', () => applyEnvOverrides(cfg));
    expect(cfg.auto_index.enabled).toBe(true);
  });

  test('unset env leaves the config alone', () => {
    const cfg = { ...structuredClone(DEFAULTS), auto_index: { enabled: false } };
    withEnv(undefined, () => applyEnvOverrides(cfg));
    expect(cfg.auto_index.enabled).toBe(false);
  });
});
