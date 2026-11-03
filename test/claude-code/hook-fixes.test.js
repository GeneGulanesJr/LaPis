// Claude Code bridge fixes: the guardrail switch, zero-file indexes, and regex
// Auto-captures kept out of injected context (and expiring).
const realStateStore = require('../../src/claude-code/state-store'),
  { loadConfig, resetConfigCache } = require('../../config'),
  { handlePreToolUse } = require('../../src/claude-code/handlers/pre-tool-use'),
  { guardrailsEnabled } = require('../../src/hooks-engine/guardrail-utils'),
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
  };
}

describe('LAPIS_GUARDRAILS env override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  test('defaults on; LAPIS_GUARDRAILS=0 turns the guardrails off', () => {
    vi.stubEnv('LAPIS_GUARDRAILS', '');
    expect(loadConfig().tool_guardrails.enabled).toBe(true);
    vi.stubEnv('LAPIS_GUARDRAILS', '0');
    expect(loadConfig().tool_guardrails.enabled).toBe(false);
  });
});

describe('PreToolUse guardrail switch', () => {
  const repo = { name: 'app', path: '/proj/app', indexed_at: 'now' },
    ON = { tool_guardrails: { enabled: true } };

  function grep(repos, config) {
    return handlePreToolUse({
      payload: { session_id: 's', tool_name: 'Grep', tool_input: { pattern: 'Pre =>|Post =>' }, cwd: '/proj/app' },
      getKnownRepos: () => repos,
      stateStore: makeStateStore(),
      autoIndex: () => ({ status: 'disabled' }),
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

describe('auto-captures are not injected', () => {
  const auto = { id: 1, type: 'bugfix', title: 'auto', content: `${AUTO_CAPTURE_PREFIX} bugfix\n**Learned**: proved` },
    manual = { id: 2, type: 'decision', title: 'manual', content: '**What**: chose X' };

  function ctx(projectResult) {
    return collectContext({
      dispatch: async (cmd, args) =>
        args['all-projects'] ? { observations: [auto, manual], stats: {} } : projectResult,
      getKnownRepos: () => [],
      project: 'app',
      cwd: '/proj/app',
      query: 'some prompt',
    });
  }

  test('from the current project', async () => {
    expect((await ctx({ observations: [auto, manual], stats: {} })).effectiveObservations).toEqual([manual]);
  });

  test('from the new-project fallback', async () => {
    const bag = await ctx({ error: 'empty' });
    expect(bag.isNewProject).toBe(true);
    expect(bag.effectiveObservations).toEqual([manual]);
  });
});

test('Stop auto-capture saves with a 7-day expiry', async () => {
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
    lastText: `${'Reviewed the loop bounds and the overflow path in detail. '.repeat(4)}Root cause was the overflow; fixed by adding Pre.`,
  });
  const saves = calls.filter((c) => c.cmd === 'save');
  expect(saves).toHaveLength(1);
  expect(saves[0].args['expires-in']).toBe('7d');
});
