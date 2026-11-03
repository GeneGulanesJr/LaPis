// Off switches + leak fixes for the Claude Code bridge: guardrails, memory
// Injection (incl. cross-project), and regex auto-capture.
const realStateStore = require('../../src/claude-code/state-store'),
  { loadConfig, resetConfigCache } = require('../../config'),
  { handlePreToolUse, guardrailsEnabled } = require('../../src/claude-code/handlers/pre-tool-use'),
  { handleUserPromptSubmit } = require('../../src/claude-code/handlers/user-prompt-submit'),
  { handleSessionStart } = require('../../src/claude-code/handlers/session-start'),
  { runStopCapture } = require('../../src/claude-code/handlers/stop'),
  { collectContext } = require('../../src/claude-code/context-inject'),
  { AUTO_CAPTURE_PREFIX } = require('../../src/hooks-engine/passive-capture');

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
    sweepStaleSessions: () => ({ swept: 0 }),
  };
}

const ON = { tool_guardrails: { enabled: true }, context_injection: { enabled: true, cross_project: false } },
  noIndex = () => ({ status: 'disabled' });

describe('config env switches', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  test('defaults: guardrails, injection and capture on; cross-project off', () => {
    vi.stubEnv('LAPIS_GUARDRAILS', '');
    vi.stubEnv('LAPIS_CONTEXT', '');
    vi.stubEnv('LAPIS_CROSS_PROJECT', '');
    vi.stubEnv('LAPIS_AUTO_CAPTURE', '');
    const cfg = loadConfig();
    expect(cfg.tool_guardrails.enabled).toBe(true);
    expect(cfg.context_injection).toEqual({ enabled: true, cross_project: false });
    expect(cfg.auto_capture.enabled).toBe(true);
  });

  test('env overrides flip each switch', () => {
    vi.stubEnv('LAPIS_GUARDRAILS', '0');
    vi.stubEnv('LAPIS_CONTEXT', 'off');
    vi.stubEnv('LAPIS_CROSS_PROJECT', '1');
    vi.stubEnv('LAPIS_AUTO_CAPTURE', 'false');
    const cfg = loadConfig();
    expect(cfg.tool_guardrails.enabled).toBe(false);
    expect(cfg.context_injection).toEqual({ enabled: false, cross_project: true });
    expect(cfg.auto_capture.enabled).toBe(false);
  });
});

describe('PreToolUse guardrail switch', () => {
  const repo = { name: 'app', path: '/proj/app', indexed_at: 'now' };

  function grep(repos, config) {
    return handlePreToolUse({
      payload: { session_id: 's', tool_name: 'Grep', tool_input: { pattern: 'Pre =>|Post =>' }, cwd: '/proj/app' },
      getKnownRepos: () => repos,
      stateStore: makeStateStore(),
      autoIndex: noIndex,
      config,
    });
  }
  const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';

  test('regex Grep in an indexed repo is denied by default', async () => {
    expect(denied(await grep([{ ...repo, file_count: 5 }], ON))).toBe(true);
  });

  test('tool_guardrails.enabled=false lets it through', async () => {
    expect(denied(await grep([{ ...repo, file_count: 5 }], { tool_guardrails: { enabled: false } }))).toBe(false);
  });

  test('an index with zero parsed files does not guard', async () => {
    expect(denied(await grep([{ ...repo, file_count: 0 }], ON))).toBe(false);
  });

  test('a repo row without file_count (old snapshot) keeps guarding', () => {
    expect(guardrailsEnabled(ON, repo)).toBe(true);
  });
});

describe('memory injection', () => {
  const auto = { id: 1, type: 'bugfix', title: 'auto', content: `${AUTO_CAPTURE_PREFIX} bugfix\n**Learned**: proved` },
    manual = { id: 2, type: 'decision', title: 'manual', content: '**What**: chose X' },
    suggestion = { id: 3, type: 'bugfix', title: 'other repo tip', project: 'elsewhere' };

  function ctx({ projectResult, config, query = 'some prompt' }) {
    return collectContext({
      dispatch: async (cmd, args) => (args['all-projects'] ? { observations: [manual], stats: {} } : projectResult),
      getKnownRepos: () => [],
      project: 'app',
      cwd: '/proj/app',
      query,
      config,
    });
  }

  test('cross-project suggestions are dropped by default and kept when enabled', async () => {
    const projectResult = { observations: [manual], cross_project_suggestions: [suggestion], stats: {} };
    expect((await ctx({ projectResult, config: ON })).crossProjectSuggestions).toEqual([]);
    const on = { context_injection: { enabled: true, cross_project: true } };
    expect((await ctx({ projectResult, config: on })).crossProjectSuggestions).toEqual([suggestion]);
  });

  test("a new project gets no other project's memories as prompt-matched", async () => {
    const bag = await ctx({ projectResult: { error: 'empty' }, config: ON });
    expect(bag.isNewProject).toBe(true);
    expect(bag.effectiveObservations).toEqual([]);
  });

  test('auto-captured memories are never injected', async () => {
    const bag = await ctx({ projectResult: { observations: [auto, manual], stats: {} }, config: ON });
    expect(bag.effectiveObservations).toEqual([manual]);
  });

  test('LAPIS_CONTEXT=0: UserPromptSubmit injects nothing', async () => {
    const calls = [],
      out = await handleUserPromptSubmit({
        payload: { session_id: 's', prompt: 'fix the stack overflow', cwd: '/proj/app' },
        dispatch: async (cmd) => {
          calls.push(cmd);
          return { observations: [manual], stats: {} };
        },
        getKnownRepos: () => [],
        stateStore: makeStateStore(),
        config: { context_injection: { enabled: false } },
      });
    expect(out).toBeNull();
    expect(calls).toEqual([]);
  });

  test('LAPIS_CONTEXT=0: SessionStart still starts the session but injects no memory', async () => {
    const calls = [],
      out = await handleSessionStart({
        payload: { session_id: 's', source: 'startup', cwd: '/proj/app' },
        dispatch: async (cmd) => {
          calls.push(cmd);
          return cmd === 'session-start' ? { sessionId: 1 } : { observations: [manual], stats: {} };
        },
        getKnownRepos: () => [],
        getKnownProjects: () => [],
        stateStore: makeStateStore(),
        autoIndex: noIndex,
        config: { context_injection: { enabled: false } },
      });
    expect(calls).toContain('session-start');
    expect(calls).not.toContain('context');
    expect(out).toBeNull();
  });
});

describe('Stop auto-capture', () => {
  const claim = `${'Reviewed the loop bounds and the overflow path in detail. '.repeat(4)}Root cause was the overflow; fixed by adding Pre.`;

  async function stop(config) {
    const calls = [],
      stateStore = makeStateStore();
    stateStore.saveState('c', { ...realStateStore.defaultState(), sessionId: 1, lastAutoDecisionSave: 0 });
    await runStopCapture({
      dispatch: async (cmd, args) => {
        calls.push({ cmd, args });
        return { ok: true };
      },
      stateStore,
      claudeSessionId: 'c',
      turnCount: 3,
      project: 'p',
      now: Date.now(),
      lastText: claim,
      config,
    });
    return calls.filter((c) => c.cmd === 'save');
  }

  test('saves with a 7-day expiry by default', async () => {
    const saves = await stop({ auto_capture: { enabled: true } });
    expect(saves).toHaveLength(1);
    expect(saves[0].args['expires-in']).toBe('7d');
  });

  test('auto_capture.enabled=false saves nothing', async () => {
    expect(await stop({ auto_capture: { enabled: false } })).toEqual([]);
  });
});
