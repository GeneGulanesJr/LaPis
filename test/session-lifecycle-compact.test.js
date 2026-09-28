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
      content = result.messages[0].content;

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
      content = result.messages[0].content;

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
      content = result.messages[0].content;

    expect(content).toContain('🆕 new project');
    expect(content).toContain('Related from elsewhere');
  });
});

describe('session_compact with Jev post-compact', () => {
  beforeEach(() => {
    process.env.JEV_DRY_RUN = '1';
  });

  test('emits a second Jev message when JEV_ENABLED=1', async () => {
    // Use dry-run so the Jev client returns canned answers (no API key needed).
    process.env.JEV_DRY_RUN = '1';
    process.env.JEV_ENABLED = '1';

    const deps = buildDeps(async () => ({
      observations: [
        { id: 1, type: 'decision', title: 'bun chosen', trust_score: 0.9 },
        { id: 2, type: 'pattern', title: 'phase 5 fallback', trust_score: 0.8 },
      ],
      personal: [],
      stats: { total_memories: 2 },
    }));

    const handler = extractHandler(deps);
    const result = await handler({}, {});

    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    const jevMessage = result.messages.find((m) => m.customType === 'jev-post-compact');
    expect(jevMessage).toBeDefined();
    expect(jevMessage.details).toBeDefined();
    expect(
      jevMessage.details.some(
        (d) => d.kind === 'reclassify' || d.kind === 'verdict',
      ),
    ).toBe(true);
  });

  test('does not emit Jev messages when JEV_ENABLED unset (and not in dry-run)', async () => {
    delete process.env.JEV_DRY_RUN;
    delete process.env.JEV_ENABLED;

    const deps = buildDeps(async () => ({
      observations: [
        { id: 1, type: 'decision', title: 'x', trust_score: 0.9 },
      ],
      personal: [],
      stats: { total_memories: 1 },
    }));

    const handler = extractHandler(deps);
    const result = await handler({}, {});

    // Only the memory-context message — no Jev overlay
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].customType).toBe('memory-context');
  });
});
