const realStateStore = require('../../src/claude-code/state-store');
const { handlePreToolUse } = require('../../src/claude-code/handlers/pre-tool-use');
const { handlePostToolUse, runGitTrustSync } = require('../../src/claude-code/handlers/post-tool-use');
const { preCategory, postCategory, isMcpLapisTool } = require('../../src/claude-code/tool-map');
const { runHook } = require('../../src/claude-code/hooks');

function makeStateStore() {
  const map = new Map();
  return {
    defaultState: realStateStore.defaultState,
    loadState: (id) => map.get(id) || realStateStore.defaultState(),
    saveState: (id, s) => {
      map.set(id, structuredClone(s));
    },
    clearState: (id) => {
      map.delete(id);
    },
    sweepStaleSessions: () => ({ swept: 0 }),
    _peek: (id) => map.get(id),
  };
}

function makeFakeDispatch(overrides = {}) {
  const calls = [];
  const dispatch = async (cmd, args) => {
    calls.push({ cmd, args });
    if (overrides[cmd]) {
      return overrides[cmd](args, calls);
    }
    return { ok: true };
  };
  return { dispatch, calls };
}

const INDEXED_REPO = { name: 'myapp', path: '/proj/myapp', indexed_at: new Date().toISOString() };

// =====================================================================
// tool-map
// =====================================================================

describe('claude-code tool-map', () => {
  test('preCategory routes native and MCP tools', () => {
    expect(preCategory('Read')).toBe('read-guardrail');
    expect(preCategory('Grep')).toBe('search-guardrail');
    expect(preCategory('mcp__lapis__memory-code')).toBe('explored-seed');
    expect(preCategory('mcp__lapis__memory-search')).toBe('reminder-reset');
    expect(preCategory('WebFetch')).toBeNull();
  });

  test('postCategory routes edit, git, and MCP mirror tools', () => {
    expect(postCategory('Write')).toBe('edit-track');
    expect(postCategory('Edit')).toBe('edit-track');
    expect(postCategory('Bash')).toBe('git-trust');
    expect(postCategory('mcp__lapis__memory-save')).toBe('tool-state-mirror');
    expect(isMcpLapisTool('mcp__lapis__memory-get')).toBe(true);
  });
});

// =====================================================================
// PreToolUse
// =====================================================================

describe('claude-code handlers: PreToolUse', () => {
  test('denies whole-file Read of indexed code without outline', async () => {
    const stateStore = makeStateStore();
    const out = await handlePreToolUse({
      payload: {
        session_id: 's1',
        cwd: '/proj/myapp',
        tool_name: 'Read',
        tool_input: { file_path: '/proj/myapp/src/index.ts' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore,
    });

    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/memory-code/);
  });

  test('allows Read with offset/limit', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's2',
        cwd: '/proj/myapp',
        tool_name: 'Read',
        tool_input: { file_path: '/proj/myapp/src/index.ts', offset: 1, limit: 50 },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out).toBeNull();
  });

  test('allows Read of config files', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's3',
        cwd: '/proj/myapp',
        tool_name: 'Read',
        tool_input: { file_path: '/proj/myapp/package.json' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out).toBeNull();
  });

  test('allows Read when file is in exploredFiles', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('s4', {
      ...realStateStore.defaultState(),
      exploredFiles: ['src/index.ts'],
    });
    const out = await handlePreToolUse({
      payload: {
        session_id: 's4',
        cwd: '/proj/myapp',
        tool_name: 'Read',
        tool_input: { file_path: '/proj/myapp/src/index.ts' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore,
    });
    expect(out).toBeNull();
  });

  test('denies broad Grep in indexed repo', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's5',
        cwd: '/proj/myapp',
        tool_name: 'Grep',
        tool_input: { pattern: 'context.*inject', path: '/proj/myapp/src' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('allows targeted Grep symbol lookup', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's6',
        cwd: '/proj/myapp',
        tool_name: 'Grep',
        tool_input: { pattern: 'rankObservations', path: '/proj/myapp/src' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out).toBeNull();
  });

  test('denies broad Glob **/* in indexed repo', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's7',
        cwd: '/proj/myapp',
        tool_name: 'Glob',
        tool_input: { pattern: '**/*', path: '/proj/myapp' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('denies bash rg in indexed repo', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's8',
        cwd: '/proj/myapp',
        tool_name: 'Bash',
        tool_input: { command: 'rg context src/' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('allows bash targeted grep', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's9',
        cwd: '/proj/myapp',
        tool_name: 'Bash',
        tool_input: { command: 'grep -rn "rankObservations" src/' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out).toBeNull();
  });

  test('does not apply bash search guardrail to git ops', async () => {
    const out = await handlePreToolUse({
      payload: {
        session_id: 's10',
        cwd: '/proj/myapp',
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore: makeStateStore(),
    });
    expect(out).toBeNull();
  });

  test('mcp memory-code seeds exploredFiles and resets reminder', async () => {
    const stateStore = makeStateStore();
    const out = await handlePreToolUse({
      payload: {
        session_id: 's11',
        cwd: '/proj/myapp',
        tool_name: 'mcp__lapis__memory-code',
        tool_input: { mode: 'outline', repo: 'myapp', file: 'src/foo.ts' },
      },
      getKnownRepos: () => [INDEXED_REPO],
      stateStore,
    });
    expect(out).toBeNull();
    const state = stateStore._peek('s11');
    expect(state.exploredFiles).toContain('src/foo.ts');
    expect(state.callsSinceLastMemory).toBe(0);
    expect(state.lastMemoryToolCall).toBeGreaterThan(0);
  });
});

// =====================================================================
// PostToolUse
// =====================================================================

describe('claude-code handlers: PostToolUse', () => {
  test('tracks edited files from Write', async () => {
    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: {
        session_id: 'p1',
        tool_name: 'Write',
        tool_input: { file_path: '/proj/myapp/src/new.ts' },
        tool_response: { success: true },
      },
      dispatch: async () => ({}),
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('p1').editedFiles).toContain('/proj/myapp/src/new.ts');
  });

  test('mirrors memory-save success counter', async () => {
    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: {
        session_id: 'p2',
        tool_name: 'mcp__lapis__memory-save',
        tool_input: { title: 'T', content: 'C' },
        tool_response: { content: [{ type: 'text', text: 'Memory saved: [#42] Title' }] },
      },
      dispatch: async () => ({}),
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('p2').memoriesSavedThisSession).toBe(1);
  });

  test('does not increment counter on duplicate warning', async () => {
    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: {
        session_id: 'p3',
        tool_name: 'mcp__lapis__memory-save',
        tool_input: { title: 'T', content: 'C' },
        tool_response: {
          content: [{ type: 'text', text: 'Potential duplicate detected:\n  - [#5] Similar' }],
        },
      },
      dispatch: async () => ({}),
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('p3').memoriesSavedThisSession).toBe(0);
  });

  test('mirrors memory-search into pendingRecallFeedback', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('p4', { ...realStateStore.defaultState(), sessionId: 77 });
    await handlePostToolUse({
      payload: {
        session_id: 'p4',
        tool_name: 'mcp__lapis__memory-search',
        tool_input: { query: 'auth flow' },
        tool_response: {
          content: [{ type: 'text', text: 'Found 1 memories:\n- [#9] [decision] Auth' }],
        },
      },
      dispatch: async () => ({}),
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('p4').pendingRecallFeedback).toEqual([[9, { sessionId: 77, query: 'auth flow' }]]);
  });

  test('mirrors memory-get by removing recall feedback entry', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('p5', {
      ...realStateStore.defaultState(),
      pendingRecallFeedback: [[9, { sessionId: 1, query: 'q' }]],
    });
    await handlePostToolUse({
      payload: {
        session_id: 'p5',
        tool_name: 'mcp__lapis__memory-get',
        tool_input: { id: 9 },
        tool_response: { content: [{ type: 'text', text: '## #9 — Title' }] },
      },
      dispatch: async () => ({}),
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('p5').pendingRecallFeedback).toEqual([]);
  });

  test('harvests explored files from memory-code response', async () => {
    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: {
        session_id: 'p6',
        tool_name: 'mcp__lapis__memory-code',
        tool_input: { mode: 'callers', repo: 'myapp', symbol: 'foo' },
        tool_response: {
          content: [{ type: 'text', text: 'Callers of foo in extensions/memory-layer/hooks/tool-guardrails.ts' }],
        },
      },
      dispatch: async () => ({}),
      getKnownRepos: () => [],
      stateStore,
    });
    const explored = stateStore._peek('p6').exploredFiles;
    expect(explored.some((f) => f.includes('tool-guardrails.ts'))).toBe(true);
  });

  test('git-trust sync fires on git pull', async () => {
    const { dispatch, calls } = makeFakeDispatch();
    const stateStore = makeStateStore();
    stateStore.saveState('p7', { ...realStateStore.defaultState(), currentProject: 'myapp' });

    await runGitTrustSync({
      dispatch,
      getKnownRepos: () => [INDEXED_REPO],
      state: stateStore._peek('p7'),
      cwd: '/proj/myapp',
    });

    expect(calls.some((c) => c.cmd === 'sync-code-trust')).toBe(true);
  });
});

// =====================================================================
// Router integration
// =====================================================================

describe('claude-code router: PreToolUse/PostToolUse wired', () => {
  test('PreToolUse returns deny JSON on stdout for blocked Read', async () => {
    const writes = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await runHook(['hook', 'PreToolUse'], {
        ensureDb: false,
        stdin: JSON.stringify({
          session_id: 'r-pre',
          cwd: '/proj/myapp',
          tool_name: 'Read',
          tool_input: { file_path: '/proj/myapp/src/index.ts' },
        }),
        getKnownRepos: () => [INDEXED_REPO],
        stateStore: makeStateStore(),
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const out = JSON.parse(writes.join('').trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('PostToolUse is silent on stdout', async () => {
    const writes = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await runHook(['hook', 'PostToolUse'], {
        ensureDb: false,
        stdin: JSON.stringify({
          session_id: 'r-post',
          tool_name: 'Write',
          tool_input: { file_path: '/p/f.ts' },
          tool_response: {},
        }),
        dispatch: async () => ({}),
        getKnownRepos: () => [],
        stateStore: makeStateStore(),
      });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(writes.join('')).toBe('');
  });
});
