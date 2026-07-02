const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const realStateStore = require('../../src/claude-code/state-store');
const { handleSessionStart } = require('../../src/claude-code/handlers/session-start');
const { handleUserPromptSubmit } = require('../../src/claude-code/handlers/user-prompt-submit');
const { handleStop, runStopCapture } = require('../../src/claude-code/handlers/stop');
const { handleSessionEnd } = require('../../src/claude-code/handlers/session-end');
const { handlePreToolUse } = require('../../src/claude-code/handlers/pre-tool-use');
const { handlePostToolUse } = require('../../src/claude-code/handlers/post-tool-use');
const { runHook } = require('../../src/claude-code/hooks');

// ---- fakes ----

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

function makeStateStore() {
  const map = new Map();
  return {
    defaultState: realStateStore.defaultState,
    loadState: (id) => map.get(id) || realStateStore.defaultState(),
    saveState: (id, s) => {
      map.set(id, s);
    },
    clearState: (id) => {
      map.delete(id);
    },
    sweepStaleSessions: () => ({ swept: 0 }),
    // test-only inspection
    _peek: (id) => map.get(id),
  };
}

const EMPTY_CONTEXT = { observations: [], personal: [], stats: { total_memories: 0, total_personal: 0 } };

function hasCall(calls, cmd, predicate) {
  return calls.some((c) => c.cmd === cmd && (!predicate || predicate(c.args)));
}

// Polls `fn` until it returns truthy, up to `timeoutMs`. Resolves with the last
// result. Used for fire-and-forget capture work whose async I/O (transcript
// stream read) settles across event-loop ticks rather than a single microtask.
function waitFor(fn, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const result = fn();
      if (result || Date.now() >= deadline) {
        resolve(result);
        return;
      }
      setImmediate(tick);
    };
    setImmediate(tick);
  });
}

// =====================================================================
// SessionStart
// =====================================================================

describe('claude-code handlers: SessionStart', () => {
  test('startup calls session-start, stores the numeric sessionId, injects context', async () => {
    const { dispatch, calls } = makeFakeDispatch({
      'session-start': () => ({ sessionId: 99, sessionCount: 4 }),
      context: () => EMPTY_CONTEXT,
    });
    const stateStore = makeStateStore();

    const out = await handleSessionStart({
      payload: { session_id: 'claude-1', source: 'startup', cwd: '/proj/myapp' },
      dispatch,
      getKnownRepos: () => [],
      stateStore,
    });

    expect(hasCall(calls, 'session-start')).toBe(true);
    expect(stateStore._peek('claude-1').sessionId).toBe(99);
    expect(stateStore._peek('claude-1').projectSessionCount).toBe(4);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Memory Context');
  });

  test('resume and clear also call session-start', async () => {
    for (const source of ['resume', 'clear']) {
      const { dispatch, calls } = makeFakeDispatch({
        'session-start': () => ({ sessionId: 1, sessionCount: 0 }),
        context: () => EMPTY_CONTEXT,
      });
      await handleSessionStart({
        payload: { session_id: `c-${source}`, source, cwd: '/p' },
        dispatch,
        getKnownRepos: () => [],
        stateStore: makeStateStore(),
      });
      expect(hasCall(calls, 'session-start')).toBe(true);
    }
  });

  test('compact does NOT call session-start (asserts dispatch call list)', async () => {
    // Pre-seed a stored numeric sessionId from a prior startup.
    const stateStore = makeStateStore();
    stateStore.saveState('claude-2', { ...realStateStore.defaultState(), sessionId: 77 });

    const { dispatch, calls } = makeFakeDispatch({ context: () => EMPTY_CONTEXT });

    const out = await handleSessionStart({
      payload: { session_id: 'claude-2', source: 'compact', cwd: '/p' },
      dispatch,
      getKnownRepos: () => [],
      stateStore,
    });

    expect(hasCall(calls, 'session-start')).toBe(false); // the key assertion
    // re-uses the stored sessionId for context
    expect(hasCall(calls, 'context', (a) => a['session-id'] === '77')).toBe(true);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  });

  test('startup passes the stored numeric sessionId as session-id to context', async () => {
    const { dispatch, calls } = makeFakeDispatch({
      'session-start': () => ({ sessionId: 55, sessionCount: 0 }),
      context: () => EMPTY_CONTEXT,
    });
    await handleSessionStart({
      payload: { session_id: 'claude-3', source: 'startup', cwd: '/p' },
      dispatch,
      getKnownRepos: () => [],
      stateStore: makeStateStore(),
    });
    expect(hasCall(calls, 'context', (a) => a['session-id'] === '55')).toBe(true);
  });
});

// =====================================================================
// UserPromptSubmit
// =====================================================================

describe('claude-code handlers: UserPromptSubmit', () => {
  test('passes stored numeric sessionId as session-id to context', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-4', { ...realStateStore.defaultState(), sessionId: 123 });
    const { dispatch, calls } = makeFakeDispatch({ context: () => EMPTY_CONTEXT });

    await handleUserPromptSubmit({
      payload: { session_id: 'claude-4', prompt: 'refactor the dispatch module', cwd: '/p' },
      dispatch,
      getKnownRepos: () => [],
      stateStore,
    });

    expect(hasCall(calls, 'context', (a) => a['session-id'] === '123' && a.query)).toBe(true);
  });

  test('preflight fires for a preflight-worthy prompt when an indexed repo exists', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-5', { ...realStateStore.defaultState(), sessionId: 1 });
    const { dispatch, calls } = makeFakeDispatch({
      context: () => EMPTY_CONTEXT,
      preflight: () => ({ likely_existing_code: [{ symbol: 'foo', file: 'a.js', line: 3 }], risk: 'low' }),
      'coding-context': () => ({ data: { target: { symbol: 'foo' } } }),
    });
    const repo = { name: 'myapp', path: '/p', indexed_at: new Date().toISOString() };

    await handleUserPromptSubmit({
      payload: { session_id: 'claude-5', prompt: 'implement the login feature', cwd: '/p' },
      dispatch,
      getKnownRepos: () => [repo],
      stateStore,
    });

    expect(hasCall(calls, 'preflight')).toBe(true);
    expect(hasCall(calls, 'coding-context')).toBe(true);
  });

  test('preflight is skipped when no indexed repo matches cwd', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-6', { ...realStateStore.defaultState(), sessionId: 1 });
    const { dispatch, calls } = makeFakeDispatch({ context: () => EMPTY_CONTEXT });

    await handleUserPromptSubmit({
      payload: { session_id: 'claude-6', prompt: 'implement the login feature', cwd: '/elsewhere' },
      dispatch,
      getKnownRepos: () => [],
      stateStore,
    });

    expect(hasCall(calls, 'preflight')).toBe(false);
  });

  test('sets hasInjectedContext and persists state', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-7', { ...realStateStore.defaultState(), sessionId: 1 });
    const { dispatch } = makeFakeDispatch({ context: () => EMPTY_CONTEXT });

    await handleUserPromptSubmit({
      payload: { session_id: 'claude-7', prompt: 'hello', cwd: '/p' },
      dispatch,
      getKnownRepos: () => [],
      stateStore,
    });

    expect(stateStore._peek('claude-7').hasInjectedContext).toBe(true);
  });
});

// =====================================================================
// PreToolUse — guardrails + memory-code explored seed
// =====================================================================

describe('claude-code handlers: PreToolUse', () => {
  test('Read blocks whole-file code reads in indexed repos until memory-code explored it', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-read', { ...realStateStore.defaultState(), currentProject: 'lapis' });

    const out = await handlePreToolUse({
      payload: {
        session_id: 'claude-read',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/foo.js' },
        cwd: '/repo',
      },
      getKnownRepos: () => [{ name: 'lapis', path: '/repo' }],
      stateStore,
    });

    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('memory-code outline --repo lapis --file src/foo.js');
  });

  test('Read allows offset/limit, config files, cross-project reads, and explored files', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-read-bypass', {
      ...realStateStore.defaultState(),
      exploredFiles: ['src/foo.js', 'foo.js'],
    });
    const base = {
      getKnownRepos: () => [{ name: 'lapis', path: '/repo' }],
      stateStore,
    };

    await expect(
      handlePreToolUse({
        ...base,
        payload: {
          session_id: 'claude-read-bypass',
          tool_name: 'Read',
          tool_input: { file_path: '/repo/src/foo.js', offset: 1 },
          cwd: '/repo',
        },
      }),
    ).resolves.toBeNull();
    await expect(
      handlePreToolUse({
        ...base,
        payload: {
          session_id: 'claude-read-bypass',
          tool_name: 'Read',
          tool_input: { file_path: '/repo/package.json' },
          cwd: '/repo',
        },
      }),
    ).resolves.toBeNull();
    await expect(
      handlePreToolUse({
        ...base,
        payload: {
          session_id: 'claude-read-bypass',
          tool_name: 'Read',
          tool_input: { file_path: '/elsewhere/src/foo.js' },
          cwd: '/repo',
        },
      }),
    ).resolves.toBeNull();
    await expect(
      handlePreToolUse({
        ...base,
        payload: {
          session_id: 'claude-read-bypass',
          tool_name: 'Read',
          tool_input: { file_path: '/repo/src/foo.js' },
          cwd: '/repo',
        },
      }),
    ).resolves.toBeNull();
  });

  test('Grep blocks broad searches but allows targeted single-file lookup', async () => {
    const stateStore = makeStateStore();
    const base = {
      getKnownRepos: () => [{ name: 'lapis', path: '/repo' }],
      stateStore,
    };

    const blocked = await handlePreToolUse({
      ...base,
      payload: {
        session_id: 'claude-grep',
        tool_name: 'Grep',
        tool_input: { pattern: 'function .*', path: '/repo/src' },
        cwd: '/repo',
      },
    });
    expect(blocked.permissionDecision).toBe('deny');
    expect(blocked.permissionDecisionReason).toContain('memory-code search --repo lapis');

    const allowed = await handlePreToolUse({
      ...base,
      payload: {
        session_id: 'claude-grep',
        tool_name: 'Grep',
        tool_input: { pattern: 'rankObservations', path: '/repo/src/ranking.js' },
        cwd: '/repo',
      },
    });
    expect(allowed).toBeNull();
  });

  test('Bash search guardrail allows piped filters and blocks raw find', async () => {
    const stateStore = makeStateStore();
    const base = {
      getKnownRepos: () => [{ name: 'lapis', path: '/repo' }],
      stateStore,
    };

    await expect(
      handlePreToolUse({
        ...base,
        payload: {
          session_id: 'claude-bash',
          tool_name: 'Bash',
          tool_input: { command: 'npm test 2>&1 | grep failed' },
          cwd: '/repo',
        },
      }),
    ).resolves.toBeNull();

    const blocked = await handlePreToolUse({
      ...base,
      payload: {
        session_id: 'claude-bash',
        tool_name: 'Bash',
        tool_input: { command: 'find src -name "*.js"' },
        cwd: '/repo',
      },
    });
    expect(blocked.permissionDecision).toBe('deny');
  });

  test('mcp memory-code seeds exploredFiles and resets reminder cadence', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-memory-code', { ...realStateStore.defaultState(), callsSinceLastMemory: 4 });

    const out = await handlePreToolUse({
      payload: {
        session_id: 'claude-memory-code',
        tool_name: 'mcp__lapis__memory-code',
        tool_input: { file: 'src/foo.js' },
      },
      getKnownRepos: () => [{ name: 'lapis', path: '/repo' }],
      stateStore,
    });

    expect(out).toBeNull();
    const state = stateStore._peek('claude-memory-code');
    expect(state.callsSinceLastMemory).toBe(0);
    expect(state.lastMemoryToolCall).toBeGreaterThan(0);
    expect(state.exploredFiles).toContain('src/foo.js');
    expect(state.exploredFiles).toContain('foo.js');
  });
});

// =====================================================================
// PostToolUse — tracking + process-boundary memory state mirroring
// =====================================================================

describe('claude-code handlers: PostToolUse', () => {
  test('tracks edited files for Write/Edit/MultiEdit tools', async () => {
    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: { session_id: 'claude-edit', tool_name: 'Edit', tool_input: { file_path: '/repo/src/foo.js' } },
      dispatch: makeFakeDispatch().dispatch,
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('claude-edit').editedFiles).toEqual(['/repo/src/foo.js']);
  });

  test('mirrors memory-save success but not duplicate warnings', async () => {
    const stateStore = makeStateStore();
    const base = {
      dispatch: makeFakeDispatch().dispatch,
      getKnownRepos: () => [],
      stateStore,
    };

    await handlePostToolUse({
      ...base,
      payload: {
        session_id: 'claude-save',
        tool_name: 'mcp__lapis__memory-save',
        tool_response: 'Memory saved: [#5] Decision',
      },
    });
    expect(stateStore._peek('claude-save').memoriesSavedThisSession).toBe(1);

    await handlePostToolUse({
      ...base,
      payload: {
        session_id: 'claude-save',
        tool_name: 'mcp__lapis__memory-save',
        tool_response: 'Potential duplicate detected:\n- [#5] Existing',
      },
    });
    expect(stateStore._peek('claude-save').memoriesSavedThisSession).toBe(1);
  });

  test('mirrors memory-search pending recall and memory-get removes useful ids', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-search', { ...realStateStore.defaultState(), sessionId: 42 });
    const base = {
      dispatch: makeFakeDispatch().dispatch,
      getKnownRepos: () => [],
      stateStore,
    };

    await handlePostToolUse({
      ...base,
      payload: {
        session_id: 'claude-search',
        tool_name: 'mcp__lapis__memory-search',
        tool_input: { query: 'bridge state' },
        tool_response: 'Found 2 memories:\n- [#5] [decision] A\n- [#6] [bugfix] B',
      },
    });
    expect(stateStore._peek('claude-search').pendingRecallFeedback).toEqual([
      [5, { sessionId: 42, query: 'bridge state' }],
      [6, { sessionId: 42, query: 'bridge state' }],
    ]);

    await handlePostToolUse({
      ...base,
      payload: {
        session_id: 'claude-search',
        tool_name: 'mcp__lapis__memory-get',
        tool_input: { id: 5 },
        tool_response: '## #5 - A',
      },
    });
    expect(stateStore._peek('claude-search').pendingRecallFeedback).toEqual([
      [6, { sessionId: 42, query: 'bridge state' }],
    ]);
  });

  test('harvests explored files from memory-code responses', async () => {
    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: {
        session_id: 'claude-code',
        tool_name: 'mcp__lapis__memory-code',
        tool_response: '**File outline**\nsrc/foo.js: function foo\nextensions/bar.ts',
      },
      dispatch: makeFakeDispatch().dispatch,
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('claude-code').exploredFiles).toEqual(
      expect.arrayContaining(['src/foo.js', 'foo.js', 'extensions/bar.ts', 'bar.ts']),
    );
  });

  test('dispatches sync-code-trust after git operations', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-git', { ...realStateStore.defaultState(), currentProject: 'lapis' });
    const { dispatch, calls } = makeFakeDispatch();

    await handlePostToolUse({
      payload: {
        session_id: 'claude-git',
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
        cwd: '/repo',
      },
      dispatch,
      getKnownRepos: () => [{ name: 'lapis', path: '/repo' }],
      stateStore,
    });

    expect(hasCall(calls, 'sync-code-trust', (a) => a.repo === 'lapis')).toBe(true);
  });
});

// =====================================================================
// Stop — silent + async capture
// =====================================================================

describe('claude-code handlers: Stop', () => {
  test('handleStop returns null (no stdout, no continuation)', async () => {
    const { dispatch } = makeFakeDispatch();
    const out = await handleStop({
      payload: { session_id: 'claude-8', cwd: '/p' },
      dispatch,
      stateStore: makeStateStore(),
    });
    expect(out).toBeNull();
  });

  test('bails out when stop_hook_active is set', async () => {
    const { dispatch, calls } = makeFakeDispatch();
    const stateStore = makeStateStore();
    stateStore.saveState('claude-9', { ...realStateStore.defaultState(), sessionId: 1, turnCount: 4 });
    await runStopCapture({
      dispatch,
      stateStore,
      claudeSessionId: 'claude-9',
      state: { ...stateStore.loadState('claude-9'), turnCount: 5 },
      project: 'p',
      now: Date.now(),
      lastText: '',
    });
    // stop_hook_active is checked in handleStop, not runStopCapture; verify
    // handleStop short-circuits before incrementing/persisting.
    const before = stateStore._peek('claude-9').turnCount;
    await handleStop({ payload: { session_id: 'claude-9', stop_hook_active: true, cwd: '/p' }, dispatch, stateStore });
    expect(stateStore._peek('claude-9').turnCount).toBe(before);
    expect(calls).toHaveLength(0);
  });

  test('increments turn and persists; checkpoint fires at turn % 10', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-10', {
      ...realStateStore.defaultState(),
      sessionId: 1,
      turnCount: 9,
      currentProject: 'p',
    });
    const { dispatch, calls } = makeFakeDispatch();

    const state = { ...stateStore.loadState('claude-10'), turnCount: 10, currentProject: 'p', editedFiles: [] };
    await runStopCapture({
      dispatch,
      stateStore,
      claudeSessionId: 'claude-10',
      state,
      project: 'p',
      now: Date.now(),
      lastText: '',
    });

    expect(hasCall(calls, 'save', (a) => a.type === 'progress')).toBe(true);
    expect(stateStore._peek('claude-10').turnCount).toBe(10);
  });

  test('dream triggers at turn 50 once', async () => {
    const stateStore = makeStateStore();
    const { dispatch, calls } = makeFakeDispatch();
    const state = {
      ...realStateStore.defaultState(),
      sessionId: 1,
      turnCount: 50,
      currentProject: 'p',
      dreamTriggeredThisSession: false,
    };
    await runStopCapture({
      dispatch,
      stateStore,
      claudeSessionId: 'x',
      state,
      project: 'p',
      now: Date.now(),
      lastText: '',
    });
    expect(hasCall(calls, 'dream')).toBe(true);
    expect(state.dreamTriggeredThisSession).toBe(true);
  });

  test('passive capture saves an auto-decision on a qualifying assistant message', async () => {
    const { dispatch, calls } = makeFakeDispatch();
    const state = { ...realStateStore.defaultState(), sessionId: 1, turnCount: 3, lastAutoDecisionSave: 0 };
    const reasoning =
      'Analyzing the requirements and constraints of this subsystem in detail before proceeding. '.repeat(4);
    const longText = `${reasoning} Based on the tradeoffs, going with a queue-based design because it avoids head-of-line blocking.`;
    await runStopCapture({
      dispatch,
      stateStore: makeStateStore(),
      claudeSessionId: 'y',
      state,
      project: 'p',
      now: Date.now(),
      lastText: longText,
    });
    expect(hasCall(calls, 'save', (a) => a.type === 'decision' || a.type === 'bugfix')).toBe(true);
  });

  test('passive capture falls back to transcript_path when no inline message', async () => {
    // Claude Code's Stop payload ships transcript_path rather than
    // last_assistant_message; handleStop must read the transcript so capture
    // actually fires in practice.
    const reasoning =
      'Analyzing the requirements and constraints of this subsystem in detail before proceeding. '.repeat(4);
    const assistantText = `${reasoning} Based on the tradeoffs, going with a queue-based design because it avoids head-of-line blocking.`;
    const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-stop-tx-'));
    const txPath = path.join(txDir, 't.jsonl');
    fs.writeFileSync(
      txPath,
      [
        JSON.stringify({ message: { role: 'user', content: 'do work' } }),
        JSON.stringify({ message: { role: 'assistant', content: assistantText } }),
      ].join('\n'),
      'utf8',
    );

    const stateStore = makeStateStore();
    stateStore.saveState('claude-tx', {
      ...realStateStore.defaultState(),
      sessionId: 1,
      turnCount: 3,
      lastAutoDecisionSave: 0,
    });
    const { dispatch, calls } = makeFakeDispatch();

    // handleStop returns null immediately (fire-and-forget); the capture work
    // — including the async transcript stream read — completes after we return.
    // Poll the dispatch record until the transcript fallback fires, since the
    // streaming read resolves across event-loop ticks, not just microtasks.
    const out = await handleStop({
      payload: { session_id: 'claude-tx', cwd: '/p', transcript_path: txPath },
      dispatch,
      stateStore,
    });
    expect(out).toBeNull();

    const captured = await waitFor(
      () => hasCall(calls, 'save', (a) => a.type === 'decision' || a.type === 'bugfix'),
      1000,
    );
    expect(captured).toBe(true);

    fs.rmSync(txDir, { recursive: true, force: true });
  });

  test('negative-recall feedback is flushed', async () => {
    const { dispatch, calls } = makeFakeDispatch();
    const state = {
      ...realStateStore.defaultState(),
      sessionId: 1,
      turnCount: 3,
      pendingRecallFeedback: [[5, { sessionId: 1, query: 'q' }]],
    };
    await runStopCapture({
      dispatch,
      stateStore: makeStateStore(),
      claudeSessionId: 'z',
      state,
      project: 'p',
      now: Date.now(),
      lastText: '',
    });
    expect(hasCall(calls, 'log-negative-recall')).toBe(true);
    expect(state.pendingRecallFeedback).toEqual([]);
  });
});

// =====================================================================
// SessionEnd — awaited, DB-derived count, clears state
// =====================================================================

describe('claude-code handlers: SessionEnd', () => {
  function writeTranscript(lines) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-end-')), 't.jsonl');
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return file;
  }

  test('runs session-summary + session-end awaited, with DB-derived count, clears state', async () => {
    const stateStore = makeStateStore();
    stateStore.saveState('claude-11', { ...realStateStore.defaultState(), sessionId: 88, currentProject: 'p' });
    const transcript = writeTranscript([JSON.stringify({ message: { role: 'user', content: 'do work' } })]);

    const { dispatch, calls } = makeFakeDispatch();
    let countedWith;
    const dispatchClient = {
      countSessionMemories: (sid) => {
        countedWith = sid;
        return 13;
      },
    };

    const out = await handleSessionEnd({
      payload: { session_id: 'claude-11', cwd: '/p', transcript_path: transcript },
      dispatch,
      dispatchClient,
      stateStore,
    });

    expect(out).toBeNull(); // silent
    expect(hasCall(calls, 'session-summary')).toBe(true);
    expect(hasCall(calls, 'session-end')).toBe(true);
    expect(countedWith).toBe(88);
    expect(hasCall(calls, 'session-end', (a) => a.memories === '13' && a.id === '88')).toBe(true);
    // state file cleared
    expect(stateStore._peek('claude-11')).toBeUndefined();
  });

  test('uses the DB count, not the in-process counter', async () => {
    const stateStore = makeStateStore();
    // In-process counter says 9999, but DB count is 2
    stateStore.saveState('claude-12', {
      ...realStateStore.defaultState(),
      sessionId: 5,
      currentProject: 'p',
      memoriesSavedThisSession: 9999,
    });
    const { dispatch, calls } = makeFakeDispatch();
    const dispatchClient = { countSessionMemories: () => 2 };

    await handleSessionEnd({
      payload: { session_id: 'claude-12', cwd: '/p', transcript_path: '' },
      dispatch,
      dispatchClient,
      stateStore,
    });

    expect(hasCall(calls, 'session-end', (a) => a.memories === '2')).toBe(true);
  });

  test('no-op when no session was started', async () => {
    const stateStore = makeStateStore();
    const { dispatch, calls } = makeFakeDispatch();
    const dispatchClient = { countSessionMemories: () => 0 };

    const out = await handleSessionEnd({
      payload: { session_id: 'claude-13', cwd: '/p' },
      dispatch,
      dispatchClient,
      stateStore,
    });

    expect(out).toBeNull();
    expect(hasCall(calls, 'session-end')).toBe(false);
  });
});

// =====================================================================
// Router — stdout purity + fail-open
// =====================================================================

describe('claude-code router (hooks.js)', () => {
  test('Stop writes nothing to stdout (silent)', async () => {
    const writes = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const { dispatch } = makeFakeDispatch();
      await runHook(['hook', 'Stop'], {
        ensureDb: false,
        stdin: JSON.stringify({ session_id: 'r-1', cwd: '/p' }),
        dispatch,
        stateStore: makeStateStore(),
      });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(writes.join('')).toBe('');
  });

  test('unknown event is a no-op (never crashes the host)', async () => {
    const { dispatch, calls } = makeFakeDispatch();
    await runHook(['hook', 'ImaginaryEvent'], {
      ensureDb: false,
      stdin: JSON.stringify({ session_id: 'r-2' }),
      dispatch,
      stateStore: makeStateStore(),
    });
    expect(calls).toHaveLength(0);
  });

  test('UserPromptSubmit clears its budget timer on the fast path', async () => {
    // Regression: a dangling setTimeout(30000) from the budget race used to
    // keep Node's event loop alive after the hook resolved, stalling the
    // process for the full budget on every prompt. Now the timer is cleared
    // when run() settles, so the handler returns with no pending handles.
    const { dispatch } = makeFakeDispatch({ context: () => EMPTY_CONTEXT });
    const t0 = Date.now();
    await runHook(['hook', 'UserPromptSubmit'], {
      ensureDb: false,
      stdin: JSON.stringify({ session_id: 'r-3', prompt: 'hello', cwd: '/p' }),
      dispatch,
      getKnownRepos: () => [],
      stateStore: makeStateStore(),
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
  });
});
