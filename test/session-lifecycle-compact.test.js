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

describe('session_compact with Decision post-compact', () => {
  beforeEach(() => {
    process.env.DECISION_DRY_RUN = '1';
  });

  test('emits a second Decision message when DECISION_ENABLED=1', async () => {
    // Use dry-run so the Decision client returns canned answers (no API key needed).
    process.env.DECISION_DRY_RUN = '1';
    process.env.DECISION_ENABLED = '1';

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
    const decisionMessage = result.messages.find((m) => m.customType === 'decision-post-compact');
    expect(decisionMessage).toBeDefined();
    expect(decisionMessage.details).toBeDefined();
    expect(decisionMessage.details.some((d) => d.kind === 'reclassify' || d.kind === 'verdict')).toBe(true);
  });

  test('does not emit Decision messages when DECISION_ENABLED unset (and not in dry-run)', async () => {
    delete process.env.DECISION_DRY_RUN;
    delete process.env.DECISION_ENABLED;

    const deps = buildDeps(async () => ({
      observations: [{ id: 1, type: 'decision', title: 'x', trust_score: 0.9 }],
      personal: [],
      stats: { total_memories: 1 },
    }));

    const handler = extractHandler(deps);
    const result = await handler({}, {});

    // Only the memory-context message — no Decision overlay
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].customType).toBe('memory-context');
  });

  test('picks up pinned policies from <cwd>/AGENTS.md when DECISION_ENABLED=1', async () => {
    process.env.DECISION_DRY_RUN = '1';
    process.env.DECISION_ENABLED = '1';

    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'lapis-compact-policies-'));
    writeFileSync(
      join(cwd, 'AGENTS.md'),
      `**PINNED POLICIES:**

- **Spelling:** letter-by-letter.
- **Confirmation:** exactly once.
`,
    );

    // Spy on the Decision client by mocking global fetch and inspecting the
    // request body (which contains the question text with policy strings).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { q: { choice: 'yes', confidence: 0.9 } } }),
    });
    globalThis.fetch = fetchMock;
    process.env.LIQUID_API_KEY = 'test-key';
    delete process.env.DECISION_DRY_RUN;

    const deps = buildDeps(async () => ({
      observations: [{ id: 1, type: 'decision', title: 'phase 5', trust_score: 0.9 }],
      personal: [],
      stats: { total_memories: 1 },
    }));

    const handler = extractHandler(deps);
    await handler({}, { cwd });

    // The C question (reclassify) was asked and contained the policies
    const reclassifyCall = fetchMock.mock.calls.find(([, init]) => {
      const body = JSON.parse(init.body);
      return (
        body.questions?.q?.instructions?.includes('PINNED POLICIES') ||
        body.questions?.q?.instructions?.includes('pinned polic')
      );
    });
    expect(reclassifyCall).toBeDefined();
    const body = JSON.parse(reclassifyCall[1].body);
    expect(body.questions.q.instructions).toContain('Spelling: letter-by-letter');
    expect(body.questions.q.instructions).toContain('Confirmation: exactly once');
  });

  test('gracefully degrades when cwd has no AGENTS.md', async () => {
    process.env.DECISION_DRY_RUN = '1';
    process.env.DECISION_ENABLED = '1';

    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'lapis-compact-empty-'));
    // no AGENTS.md written

    const deps = buildDeps(async () => ({
      observations: [{ id: 1, type: 'decision', title: 'phase 5', trust_score: 0.9 }],
      personal: [],
      stats: { total_memories: 1 },
    }));

    const handler = extractHandler(deps);
    const result = await handler({}, { cwd });

    // Decision still called (with "no pinned policies declared"); no error
    const decisionMessage = result.messages.find((m) => m.customType === 'decision-post-compact');
    expect(decisionMessage).toBeDefined();
  });

  test('first compact in session sends empty lostTopics when no baseline exists', async () => {
    process.env.DECISION_DRY_RUN = '1';
    process.env.DECISION_ENABLED = '1';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { q: { score: 2, confidence: 0.8 } } }),
    });
    globalThis.fetch = fetchMock;
    process.env.LIQUID_API_KEY = 'test-key';
    delete process.env.DECISION_DRY_RUN;

    const state = { currentProject: 'TestProject', sessionId: 1, preCompactTitles: null };
    const deps = {
      state,
      mem: vi.fn(async () => ({
        observations: [
          { id: 1, type: 'decision', title: 'phase 5 fallback', trust_score: 0.9 },
          { id: 2, type: 'pattern', title: 'bun chosen', trust_score: 0.8 },
        ],
        personal: [],
        stats: { total_memories: 2 },
      })),
    };
    const handler = extractHandler(deps);
    await handler({}, {});

    // Find the verdict question call (A)
    const verdictCall = fetchMock.mock.calls.find(([, init]) => {
      const body = JSON.parse(init.body);
      const q = body.questions?.q?.instructions || '';
      return q.includes('lost') || q.includes('completely');
    });
    expect(verdictCall).toBeDefined();
    const body = JSON.parse(verdictCall[1].body);
    expect(body.questions.q.instructions).toMatch(/nothing (was )?lost/);

    // State was updated for the next compact in the same session
    expect(state.preCompactTitles).toEqual(['phase 5 fallback', 'bun chosen']);
  });

  test('second compact diffs lost topics against post-first-compact baseline', async () => {
    process.env.DECISION_DRY_RUN = '1';
    process.env.DECISION_ENABLED = '1';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { q: { score: 1, confidence: 0.7 } } }),
    });
    globalThis.fetch = fetchMock;
    process.env.LIQUID_API_KEY = 'test-key';
    delete process.env.DECISION_DRY_RUN;

    // Simulate that the first compact already ran; baseline now reflects
    // post-first-compact titles.
    const state = {
      currentProject: 'TestProject',
      sessionId: 1,
      preCompactTitles: ['phase 5 fallback', 'bun chosen', 'verifier ready'],
    };
    let callIndex = 0;
    const deps = {
      state,
      mem: vi.fn(async () => {
        callIndex += 1;
        if (callIndex === 1) {
          // Project context call returns the new (post-compact) titles
          return {
            observations: [
              { id: 1, type: 'decision', title: 'phase 5 fallback', trust_score: 0.9 },
              { id: 2, type: 'pattern', title: 'bun chosen', trust_score: 0.8 },
            ],
            personal: [],
            stats: { total_memories: 2 },
          };
        }
        return null;
      }),
    };
    const handler = extractHandler(deps);
    await handler({}, {});

    // Find the verdict question call (A)
    const verdictCall = fetchMock.mock.calls.find(([, init]) => {
      const body = JSON.parse(init.body);
      const q = body.questions?.q?.instructions || '';
      return q.includes('Topics lost') || q.includes('completely');
    });
    expect(verdictCall).toBeDefined();
    const body = JSON.parse(verdictCall[1].body);
    // 'verifier ready' was in before but not in after -> lost topic
    expect(body.questions.q.instructions).toContain('verifier ready');
    // 'phase 5 fallback' is also in after -> NOT a lost topic (it's in the
    // re-injected section, which is fine; the lost-topics list does not
    // include it). The lost-topics block uses '- <topic>\n' format.
    const lostBlock = body.questions.q.instructions
      .split('Topics lost during compaction:\n')[1]
      .split('\n\nMemories re-injected')[0];
    expect(lostBlock).toContain('verifier ready');
    expect(lostBlock).not.toContain('phase 5 fallback');

    // Baseline updated to new titles
    expect(state.preCompactTitles).toEqual(['phase 5 fallback', 'bun chosen']);
  });
});
