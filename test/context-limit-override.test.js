import { registerBeforeAgentStart } from '../extensions/memory-layer/hooks/context-injection.ts';

/**
 * Tests for the optional `contextLimit` extension setting.
 *
 * When `getSettings().contextLimit` is provided as a positive number, the hook
 * should use it instead of the built-in defaults
 * (CONTEXT.PROMPT_RELEVANT_LIMIT = 3 or CONTEXT.PROJECT_SUMMARY_LIMIT = 1).
 */

function buildDeps(overrides = {}) {
  return {
    state: { currentProject: 'TestProject', hasInjectedContext: false, sessionId: 1 },
    mem: vi.fn().mockResolvedValue({
      observations: [],
      personal: [],
      stats: { total_memories: 10, total_personal: 0 },
      topic: null,
    }),
    getKnownRepos: vi.fn().mockResolvedValue([]),
    isRepoStale: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function extractHandler(deps) {
  let handler;
  const pi = {
    on: vi.fn((_eventName, callback) => {
      handler = callback;
    }),
  };
  registerBeforeAgentStart(pi, deps);
  return handler;
}

describe('contextLimit extension setting', () => {
  test('uses contextLimit from getSettings instead of default PROMPT_RELEVANT_LIMIT (3)', async () => {
    const deps = buildDeps({
        getSettings: () => ({ contextLimit: 20 }),
      }),
      handler = extractHandler(deps);

    await handler({ prompt: 'some query' }, { cwd: process.cwd() });

    expect(deps.mem).toHaveBeenCalledWith('context', expect.objectContaining({ limit: '20' }));
  });

  test('uses contextLimit from getSettings instead of default PROJECT_SUMMARY_LIMIT (1)', async () => {
    const deps = buildDeps({
        getSettings: () => ({ contextLimit: 15 }),
      }),
      handler = extractHandler(deps);

    // No prompt → would normally use PROJECT_SUMMARY_LIMIT (1)
    await handler({}, { cwd: process.cwd() });

    expect(deps.mem).toHaveBeenCalledWith('context', expect.objectContaining({ limit: '15' }));
  });

  test('falls back to PROMPT_RELEVANT_LIMIT (3) when getSettings returns no contextLimit', async () => {
    const deps = buildDeps({
        getSettings: () => ({}),
      }),
      handler = extractHandler(deps);

    await handler({ prompt: 'some query' }, { cwd: process.cwd() });

    expect(deps.mem).toHaveBeenCalledWith('context', expect.objectContaining({ limit: '3' }));
  });

  test('falls back to PROJECT_SUMMARY_LIMIT (1) when getSettings is not provided', async () => {
    const deps = buildDeps(),
      handler = extractHandler(deps);

    await handler({}, { cwd: process.cwd() });

    expect(deps.mem).toHaveBeenCalledWith('context', expect.objectContaining({ limit: '1' }));
  });

  test('ignores contextLimit of 0 and uses default', async () => {
    const deps = buildDeps({
        getSettings: () => ({ contextLimit: 0 }),
      }),
      handler = extractHandler(deps);

    await handler({ prompt: 'some query' }, { cwd: process.cwd() });

    // ContextLimit=0 is not a valid override → falls back to PROMPT_RELEVANT_LIMIT (3)
    expect(deps.mem).toHaveBeenCalledWith('context', expect.objectContaining({ limit: '3' }));
  });

  test('ignores negative contextLimit and uses default', async () => {
    const deps = buildDeps({
        getSettings: () => ({ contextLimit: -3 }),
      }),
      handler = extractHandler(deps);

    await handler({}, { cwd: process.cwd() });

    // Negative contextLimit → falls back to PROJECT_SUMMARY_LIMIT (1)
    expect(deps.mem).toHaveBeenCalledWith('context', expect.objectContaining({ limit: '1' }));
  });
});
