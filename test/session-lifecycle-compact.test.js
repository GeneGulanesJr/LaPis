import { registerSessionCompact } from '../extensions/memory-layer/hooks/session-lifecycle.ts';

function extractHandler(deps) {
  let handler;
  const pi = {
    on: vi.fn((_eventName, callback) => {
      handler = callback;
    }),
  };
  registerSessionCompact(pi, deps);
  return handler;
}

function buildDeps(memImpl) {
  return {
    state: { currentProject: 'TestProject', sessionId: 1 },
    mem: vi.fn(memImpl),
  };
}

describe('session_compact re-injection', () => {
  test('uses cross-project memories when project context is non-null but empty', async () => {
    const deps = buildDeps(async (_cmd, args) => {
        if (args && args['all-projects'] === 'true') {
          return {
            observations: [{ type: 'decision', title: 'Cross-project decision' }],
            personal: [],
            stats: {},
          };
        }
        // Project context call returns a non-null result with ZERO observations.
        return { observations: [], personal: [], stats: { total_memories: 0 } };
      }),
      handler = extractHandler(deps),
      result = await handler({}, {}),
      content = result.message.content;

    // Pre-fix bug: fetched cross-project memories were discarded, showing "0 memories".
    expect(content).toContain('Cross-project decision');
    expect(content).not.toContain('0 memories');
  });

  test('uses project observations when present and does not fetch cross-project', async () => {
    const mem = vi.fn(async () => ({
        observations: [{ type: 'pattern', title: 'Project pattern', trust_score: 0.9 }],
        personal: [],
        stats: { total_memories: 5 },
      })),
      deps = {
        state: { currentProject: 'TestProject', sessionId: 1 },
        mem,
      },
      handler = extractHandler(deps),
      result = await handler({}, {}),
      content = result.message.content;

    expect(content).toContain('Project pattern');
    expect(content).toContain('5 memories');
    // Only the project context call should have been made.
    expect(mem).toHaveBeenCalledTimes(1);
    expect((mem.mock.calls[0][1] || {})['all-projects']).toBeUndefined();
  });

  test('handles truly new project (null project context)', async () => {
    const deps = buildDeps(async (_cmd, args) => {
        if (args && args['all-projects'] === 'true') {
          return {
            observations: [{ type: 'bugfix', title: 'Related from elsewhere' }],
            personal: [],
            stats: {},
          };
        }
        return null;
      }),
      handler = extractHandler(deps),
      result = await handler({}, {}),
      content = result.message.content;

    expect(content).toContain('🆕 new project');
    expect(content).toContain('Related from elsewhere');
  });
});
