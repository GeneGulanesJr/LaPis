const realStateStore = require('../../src/claude-code/state-store');
const { handlePreToolUse } = require('../../src/claude-code/handlers/pre-tool-use');
const { handlePostToolUse } = require('../../src/claude-code/handlers/post-tool-use');

function makeStateStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    defaultState: realStateStore.defaultState,
    loadState: (id) => map.get(id) || realStateStore.defaultState(),
    saveState: (id, s) => {
      map.set(id, s);
    },
    mutateState: async (id, mutator) => {
      const s = map.get(id) || realStateStore.defaultState();
      const r = await mutator(s);
      map.set(id, s);
      return r;
    },
    clearState: (id) => map.delete(id),
    sweepStaleSessions: () => ({ swept: 0 }),
    _peek: (id) => map.get(id),
  };
}

function makeFakeDispatch(overrides = {}) {
  const calls = [];
  const dispatch = async (cmd, args) => {
    calls.push({ cmd, args });
    return overrides[cmd] ? overrides[cmd](args) : { ok: true };
  };
  return { dispatch, calls };
}

function isDeny(out) {
  return !!(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny');
}

const APP_REPO = { name: 'app', path: '/proj/app', indexed_at: new Date().toISOString() };
const reposFn = () => [APP_REPO];

// =====================================================================
// PreToolUse — Read guardrail
// =====================================================================

describe('claude-code PreToolUse: Read guardrail', () => {
  async function runRead(tool_input, opts = {}) {
    return handlePreToolUse({
      payload: { session_id: 's', tool_name: 'Read', tool_input, cwd: '/proj/app' },
      getKnownRepos: opts.repos || reposFn,
      stateStore: opts.stateStore || makeStateStore(),
    });
  }

  test('blocks a whole-file read of indexed code', async () => {
    const out = await runRead({ file_path: 'src/db.js' });
    expect(isDeny(out)).toBe(true);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('memory-code outline');
  });

  test('allows a targeted slice read (offset/limit)', async () => {
    expect(isDeny(await runRead({ file_path: 'src/db.js', offset: 10, limit: 20 }))).toBe(false);
  });

  test('allows a config file', async () => {
    expect(isDeny(await runRead({ file_path: 'package.json' }))).toBe(false);
  });

  test('allows node_modules', async () => {
    expect(isDeny(await runRead({ file_path: 'node_modules/foo/index.js' }))).toBe(false);
  });

  test('allows a non-code file', async () => {
    expect(isDeny(await runRead({ file_path: 'README.md' }))).toBe(false);
  });

  test('allows a cross-project (outside cwd) read', async () => {
    expect(isDeny(await runRead({ file_path: '/elsewhere/x.js' }))).toBe(false);
  });

  test('allows when the file was already explored', async () => {
    const stateStore = makeStateStore({
      s: { ...realStateStore.defaultState(), exploredFiles: ['src/db.js'] },
    });
    expect(isDeny(await runRead({ file_path: 'src/db.js' }, { stateStore }))).toBe(false);
  });

  test('allows when explored path uses a different separator style', async () => {
    const stateStore = makeStateStore({
      s: { ...realStateStore.defaultState(), exploredFiles: ['src\\db.js'] },
    });
    expect(isDeny(await runRead({ file_path: 'src/db.js' }, { stateStore }))).toBe(false);
  });

  test('allows reads in an unindexed project (deferred auto-index)', async () => {
    expect(isDeny(await runRead({ file_path: 'src/db.js' }, { repos: () => [] }))).toBe(false);
  });
});

// =====================================================================
// PreToolUse — Grep (primary) / Glob / Bash guardrails
// =====================================================================

describe('claude-code PreToolUse: Grep guardrail (primary)', () => {
  async function runGrep(tool_input, repos = reposFn) {
    return handlePreToolUse({
      payload: { session_id: 's', tool_name: 'Grep', tool_input, cwd: '/proj/app' },
      getKnownRepos: repos,
      stateStore: makeStateStore(),
    });
  }

  test('blocks a broad regex search in an indexed repo', async () => {
    const out = await runGrep({ pattern: 'function\\s+\\w+' });
    expect(isDeny(out)).toBe(true);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('memory-code search');
  });

  test('allows a targeted single-symbol lookup', async () => {
    expect(isDeny(await runGrep({ pattern: 'rankObservations' }))).toBe(false);
  });

  test('allows any pattern scoped to a single file', async () => {
    expect(isDeny(await runGrep({ pattern: 'foo|bar', path: 'src/db.js' }))).toBe(false);
  });

  test('allows a broad search in an unindexed repo', async () => {
    expect(isDeny(await runGrep({ pattern: 'foo.*bar' }, () => []))).toBe(false);
  });
});

describe('claude-code PreToolUse: Glob + Bash guardrails', () => {
  function payload(tool_name, tool_input) {
    return { session_id: 's', tool_name, tool_input, cwd: '/proj/app' };
  }
  const run = (tool_name, tool_input) =>
    handlePreToolUse({ payload: payload(tool_name, tool_input), getKnownRepos: reposFn, stateStore: makeStateStore() });

  test('Glob blocks broad **/* discovery', async () => {
    expect(isDeny(await run('Glob', { pattern: '**/*.ts' }))).toBe(true);
  });

  test('Glob allows a scoped glob', async () => {
    expect(isDeny(await run('Glob', { pattern: 'src/**/*.ts' }))).toBe(false);
  });

  test('Bash blocks raw find in an indexed repo', async () => {
    expect(isDeny(await run('Bash', { command: 'find . -name "*.ts"' }))).toBe(true);
  });

  test('Bash allows a piped output filter', async () => {
    expect(isDeny(await run('Bash', { command: 'npx oxlint 2>&1 | grep -i unused' }))).toBe(false);
  });

  test('Bash allows a targeted symbol grep', async () => {
    expect(isDeny(await run('Bash', { command: 'grep -rn "rankObservations" src/' }))).toBe(false);
  });

  test('Bash ignores non-search commands', async () => {
    expect(isDeny(await run('Bash', { command: 'npm test' }))).toBe(false);
  });

  test('Bash blocks compound search commands (cd repo && find)', async () => {
    // #226: the full command string is classified, not a prefix-matched if-rule.
    expect(isDeny(await run('Bash', { command: 'cd /proj/app && find . -name "*.ts"' }))).toBe(true);
  });
});

// =====================================================================
// PreToolUse — memory-code seed + reminder reset
// =====================================================================

describe('claude-code PreToolUse: memory-tool bookkeeping', () => {
  test('memory-code seeds exploredFiles and resets the reminder cadence', async () => {
    const stateStore = makeStateStore({
      s: { ...realStateStore.defaultState(), callsSinceLastMemory: 4 },
    });
    const out = await handlePreToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-code',
        tool_input: { file: 'src/foo.ts' },
        cwd: '/proj/app',
      },
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(out).toBeNull();
    const st = stateStore._peek('s');
    expect(st.exploredFiles).toContain('src/foo.ts');
    expect(st.exploredFiles).toContain('foo.ts');
    expect(st.callsSinceLastMemory).toBe(0);
    expect(st.lastMemoryToolCall).toBeGreaterThan(0);
  });

  test('any memory-* tool resets the reminder cadence', async () => {
    const stateStore = makeStateStore({
      s: { ...realStateStore.defaultState(), callsSinceLastMemory: 9 },
    });
    await handlePreToolUse({
      payload: { session_id: 's', tool_name: 'mcp__lapis__memory-save', tool_input: {}, cwd: '/proj/app' },
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(stateStore._peek('s').callsSinceLastMemory).toBe(0);
  });
});

// =====================================================================
// PostToolUse — edit-track + git-trust
// =====================================================================

describe('claude-code PostToolUse: edit-track + git-trust', () => {
  test('Write records file_path in editedFiles', async () => {
    const stateStore = makeStateStore();
    const { dispatch } = makeFakeDispatch();
    const out = await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'Write',
        tool_input: { file_path: '/proj/app/src/x.js' },
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(out).toBeNull();
    expect(stateStore._peek('s').editedFiles).toContain('/proj/app/src/x.js');
  });

  test('git pull triggers sync-code-trust for the current repo', async () => {
    const stateStore = makeStateStore({
      s: { ...realStateStore.defaultState(), currentProject: 'app' },
    });
    const { dispatch, calls } = makeFakeDispatch();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(calls.some((c) => c.cmd === 'sync-code-trust' && c.args.repo === 'app')).toBe(true);
  });

  test('a compound git command (cd repo && git pull) still triggers sync-code-trust', async () => {
    // #225: the install `if: "Bash(git *)"` prefix rule used to skip this; now
    // the Bash PostToolUse matcher is bare and GIT_TRUST_OP_RE classifies it.
    const stateStore = makeStateStore({ s: { ...realStateStore.defaultState(), currentProject: 'app' } });
    const { dispatch, calls } = makeFakeDispatch();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'cd /proj/app && git pull origin main' },
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
      roleFilter: { only: 'git-trust' },
    });
    expect(calls.some((c) => c.cmd === 'sync-code-trust' && c.args.repo === 'app')).toBe(true);
  });

  test('git -C <path> pull triggers sync-code-trust', async () => {
    const stateStore = makeStateStore({ s: { ...realStateStore.defaultState(), currentProject: 'app' } });
    const { dispatch, calls } = makeFakeDispatch();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'git -C /proj/app pull origin main' },
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
      roleFilter: { only: 'git-trust' },
    });
    expect(calls.some((c) => c.cmd === 'sync-code-trust' && c.args.repo === 'app')).toBe(true);
  });

  test('MultiEdit records each edited file path', async () => {
    const stateStore = makeStateStore();
    const { dispatch } = makeFakeDispatch();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'MultiEdit',
        tool_input: {
          edits: [{ file_path: '/proj/app/src/a.js' }, { file_path: '/proj/app/src/b.js' }],
        },
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    const edited = stateStore._peek('s').editedFiles;
    expect(edited).toContain('/proj/app/src/a.js');
    expect(edited).toContain('/proj/app/src/b.js');
  });

  test('non-git bash does not trigger sync-code-trust', async () => {
    const stateStore = makeStateStore({ s: { ...realStateStore.defaultState(), currentProject: 'app' } });
    const { dispatch, calls } = makeFakeDispatch();
    await handlePostToolUse({
      payload: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/proj/app' },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(calls.some((c) => c.cmd === 'sync-code-trust')).toBe(false);
  });
});

// =====================================================================
// PostToolUse — tool-state mirroring (process-boundary fix)
// =====================================================================

describe('claude-code PostToolUse: tool-state mirroring', () => {
  const dispatchOf = () => makeFakeDispatch();

  test('memory-save success increments the counter', async () => {
    const stateStore = makeStateStore();
    const { dispatch } = dispatchOf();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-save',
        tool_input: {},
        tool_response: '✅ Memory saved: [#42] My decision',
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(stateStore._peek('s').memoriesSavedThisSession).toBe(1);
  });

  test('memory-save duplicate warning does NOT increment', async () => {
    const stateStore = makeStateStore();
    const { dispatch } = dispatchOf();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-save',
        tool_input: {},
        tool_response: '⚠️ Potential duplicate detected:\n  - [#9] Existing (88% similar)',
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(stateStore._peek('s').memoriesSavedThisSession).toBe(0);
  });

  test('memory-search populates pendingRecallFeedback', async () => {
    const stateStore = makeStateStore({ s: { ...realStateStore.defaultState(), sessionId: 7 } });
    const { dispatch } = dispatchOf();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-search',
        tool_input: { query: 'dispatch' },
        tool_response: 'Found 2 memories:\n- [#1] [decision] A\n- [#2] [bugfix] B',
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    const pending = stateStore._peek('s').pendingRecallFeedback;
    expect(pending.map(([id]) => id)).toEqual([1, 2]);
    expect(pending[0][1]).toEqual({ sessionId: 7, query: 'dispatch' });
  });

  test('memory-search mirrors the real MCP JSON shape (content block, no markers)', async () => {
    const stateStore = makeStateStore({ s: { ...realStateStore.defaultState(), sessionId: 3 } });
    const { dispatch } = dispatchOf();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-search',
        tool_input: { query: 'q' },
        // src/mcp/translate-result.js JSON-stringifies the dispatch result.
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 8 }, { id: 9 }] }) }] },
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(stateStore._peek('s').pendingRecallFeedback.map(([id]) => id)).toEqual([8, 9]);
  });

  test('memory-get removes the consumed id (marked useful)', async () => {
    const stateStore = makeStateStore({
      s: {
        ...realStateStore.defaultState(),
        pendingRecallFeedback: [
          [1, { sessionId: 7, query: 'q' }],
          [2, { sessionId: 7, query: 'q' }],
        ],
      },
    });
    const { dispatch } = dispatchOf();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-get',
        tool_input: { id: 1 },
        tool_response: '## #1 — A\nType: decision',
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    expect(stateStore._peek('s').pendingRecallFeedback.map(([id]) => id)).toEqual([2]);
  });

  test('memory-code harvests file paths into exploredFiles', async () => {
    const stateStore = makeStateStore();
    const { dispatch } = dispatchOf();
    await handlePostToolUse({
      payload: {
        session_id: 's',
        tool_name: 'mcp__lapis__memory-code',
        tool_input: { mode: 'callers' },
        tool_response: 'Callers of foo:\n- src/db.js:42\n- src/mcp/server.js:10',
        cwd: '/proj/app',
      },
      dispatch,
      getKnownRepos: reposFn,
      stateStore,
    });
    const explored = stateStore._peek('s').exploredFiles;
    expect(explored).toContain('src/db.js');
    expect(explored).toContain('src/mcp/server.js');
  });
});
