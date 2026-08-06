import {
  extractUserPrompt,
  isHistoricalMemoryPrompt,
  isPreflightWorthyPrompt,
  isSourceAuthoritativePrompt,
  registerBeforeAgentStart,
} from '../extensions/memory-layer/hooks/context-injection.ts';

describe('context injection prompt extraction', () => {
  test('uses the latest user message content parts', () => {
    const prompt = extractUserPrompt({
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: [{ type: 'text', text: 'Where is context injection wired?' }] },
      ],
    });

    expect(prompt).toBe('Where is context injection wired?');
  });

  test('falls back to prompt-like event fields', () => {
    expect(extractUserPrompt({ prompt: 'Why FTS5?' })).toBe('Why FTS5?');
  });

  test('returns null when no text prompt is available', () => {
    expect(extractUserPrompt({ messages: [{ role: 'assistant', content: 'Nope' }] })).toBeNull();
  });

  test('detects prompts that should inspect current source instead of auto memory', () => {
    expect(
      isSourceAuthoritativePrompt(
        'In the current source, what does rankObservations multiply by typeBoost? Answer from the code.',
      ),
    ).toBe(true);
    expect(isSourceAuthoritativePrompt('Where is automatic project memory context wired into the Pi extension?')).toBe(
      false,
    );
  });

  test('detects historical memory prompts', () => {
    expect(isHistoricalMemoryPrompt('Why did LaPis choose SQLite FTS5?')).toBe(true);
    expect(isHistoricalMemoryPrompt('What bug led to the createDb pattern?')).toBe(true);
    expect(isHistoricalMemoryPrompt('In the current source, what does rankObservations multiply?')).toBe(false);
  });

  test('source-authoritative prompts bypass memory facts but keep code lookup guidance', async () => {
    let handler;
    const pi = {
      on: vi.fn((_eventName, callback) => {
        handler = callback;
      }),
    };
    const deps = {
      state: { currentProject: 'PiMemoryExtension', hasInjectedContext: false, sessionId: 1 },
      mem: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'PiMemoryExtension',
          path: process.cwd(),
          file_count: 292,
          symbol_count: 6913,
          indexed_at: '2026-05-24 00:00:00',
        },
      ]),
      isRepoStale: vi.fn(),
    };

    registerBeforeAgentStart(pi, deps);
    const result = await handler(
      {
        messages: [
          {
            role: 'user',
            content: 'In the current source, what fields does context return? Answer from the code.',
          },
        ],
      },
      { cwd: process.cwd() },
    );

    expect(deps.mem).not.toHaveBeenCalled();
    expect(deps.state.hasInjectedContext).toBe(false);
    expect(result.message.content).toContain('## Code Lookup Guidance');
    expect(result.message.content).toContain('targeted current-source lookup');
    expect(result.message.content).toContain('rg -n "<symbol>" <narrow-path>');
    expect(result.message.content).toContain('memory-domain context');
    expect(result.message.content).toContain('src/memory-domain/context.js');
    expect(result.message.content).toContain('memory-code search --repo PiMemoryExtension');
    expect(result.message.content).toContain('small targeted `read`');
    expect(result.message.content).toContain('skip `memory-code outline`');
    expect(result.message.content).not.toContain('Prompt-Matched Memory');
  });

  test('promptless startup injects project summary without memory titles', async () => {
    let handler;
    const pi = {
      on: vi.fn((_eventName, callback) => {
        handler = callback;
      }),
    };
    const deps = {
      state: { currentProject: 'PiMemoryExtension', hasInjectedContext: false, sessionId: 1 },
      mem: vi.fn().mockResolvedValue({
        observations: [{ type: 'decision', title: 'Noisy prior decision', trust_score: 0.95 }],
        personal: [{ title: 'Personal preference' }],
        stats: { total_memories: 42, total_personal: 1, active_workflows: 0 },
        topic: null,
      }),
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'PiMemoryExtension',
          path: process.cwd(),
          file_count: 292,
          symbol_count: 6913,
          indexed_at: '2026-05-24 00:00:00',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(false),
    };

    registerBeforeAgentStart(pi, deps);
    const result = await handler({}, { cwd: process.cwd() });
    const content = result.message.content;

    expect(deps.mem).toHaveBeenCalledWith(
      'context',
      expect.objectContaining({ project: 'PiMemoryExtension', limit: '1' }),
    );
    // Rich format: structured sections with Project Context
    expect(content).toContain('## Memory Context (auto-loaded)');
    expect(content).toContain('### Project Context');
    expect(content).toContain('Code index: `PiMemoryExtension`');
    expect(content).not.toContain('Noisy prior decision');
    expect(content).not.toContain('Personal preference');
  });

  test('policy prompt caps injected memories to one and omits Related paths', async () => {
    let handler;
    const pi = {
      on: vi.fn((_eventName, callback) => {
        handler = callback;
      }),
    };
    const deps = {
      state: { currentProject: 'PiMemoryExtension', hasInjectedContext: false, sessionId: 1 },
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'decision',
            title: 'Matched decision 1',
            trust_score: 0.95,
            content: '**What**: Use SQLite FTS5\n**Why**: Avoid external search services\n**Where**: src/search.js',
          },
          {
            type: 'bugfix',
            title: 'Matched bugfix 2',
            trust_score: 0.95,
            content: '**What**: Fixed config leak',
          },
          {
            type: 'pattern',
            title: 'Matched pattern 3',
            trust_score: 0.95,
            content: '**What**: Should not be injected',
          },
        ],
        personal: [],
        stats: { total_memories: 42, total_personal: 0, active_workflows: 0 },
        topic: 'benchmark',
      }),
      getKnownRepos: vi.fn().mockResolvedValue([]),
      isRepoStale: vi.fn().mockReturnValue(false),
    };

    registerBeforeAgentStart(pi, deps);
    const prompt = 'what should the agent do before relying on stale code-memory results?';
    const result = await handler({ prompt }, { cwd: process.cwd() });
    const content = result.message.content;

    expect(deps.mem).toHaveBeenCalledWith(
      'context',
      expect.objectContaining({ project: 'PiMemoryExtension', limit: '3', query: prompt }),
    );
    // Policy/advice prompts should stay compact: inject only the best memory and no Related file paths.
    expect(content).toContain('### Prompt-Matched Memory');
    expect(content).toContain('Matched decision 1');
    expect(content).toContain('What: Use SQLite FTS5 Why: Avoid external search services Where: src/search.js');
    expect(content).not.toContain('Related:');
    expect(content).not.toContain('Matched bugfix 2');
    expect(content).not.toContain('Matched pattern 3');
    expect(content).not.toContain('Should not be injected');
  });

  test('navigation prompt injects up to two memories and includes Related paths', async () => {
    let handler;
    const pi = {
      on: vi.fn((_eventName, callback) => {
        handler = callback;
      }),
    };
    const deps = {
      state: { currentProject: 'PiMemoryExtension', hasInjectedContext: false, sessionId: 1 },
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'decision',
            title: 'Matched decision 1',
            trust_score: 0.95,
            content: '**What**: Use SQLite FTS5\n**Why**: Avoid external search services\n**Where**: src/search.js',
          },
          {
            type: 'bugfix',
            title: 'Matched bugfix 2',
            trust_score: 0.95,
            content: '**What**: Fixed config leak\n**Where**: src/config.js',
          },
          {
            type: 'pattern',
            title: 'Matched pattern 3',
            trust_score: 0.95,
            content: '**What**: Third complementary memory\n**Where**: src/pattern.js',
          },
        ],
        personal: [],
        stats: { total_memories: 42, total_personal: 0, active_workflows: 0 },
        topic: 'benchmark',
      }),
      getKnownRepos: vi.fn().mockResolvedValue([]),
      isRepoStale: vi.fn().mockReturnValue(false),
    };

    registerBeforeAgentStart(pi, deps);
    const prompt = 'identify the current search module path';
    const result = await handler({ prompt }, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('Matched decision 1');
    expect(content).toContain('Matched bugfix 2');
    expect(content).not.toContain('Matched pattern 3');
    expect(content).toContain('Related: `src/search.js`');
    expect(content).toContain('Related: `src/config.js`');
    expect(content).not.toContain('Related: `src/pattern.js`');
  });

  test('historical prompt suppresses stale code verification warning', async () => {
    let handler;
    const pi = {
      on: vi.fn((_eventName, callback) => {
        handler = callback;
      }),
    };
    const deps = {
      state: { currentProject: 'PiMemoryExtension', hasInjectedContext: false, sessionId: 1 },
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'architecture',
            title: 'SQLite FTS5 rationale',
            trust_score: 0.95,
            content: '**Why**: Avoid external services\n**Where**: src/memory-domain/search.js',
          },
        ],
        personal: [],
        stats: { total_memories: 42, total_personal: 0, active_workflows: 0 },
        topic: 'why fts5',
      }),
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'PiMemoryExtension',
          path: process.cwd(),
          file_count: 292,
          symbol_count: 6913,
          indexed_at: '2026-05-24 00:00:00',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(true),
    };

    registerBeforeAgentStart(pi, deps);
    const result = await handler({ prompt: 'Why did LaPis choose SQLite FTS5?' }, { cwd: process.cwd() });
    const content = result.message.content;

    // Historical prompt: stale warning suppressed, code index still shown
    expect(content).toContain('Code index: `PiMemoryExtension`');
    expect(content).not.toContain('Stale code index');
    expect(content).toContain('Why: Avoid external services Where: src/memory-domain/search.js');
  });

  test('coding prompt auto-injects coding-context after preflight', async () => {
    let handler;
    const pi = {
      on: vi.fn((_eventName, callback) => {
        handler = callback;
      }),
    };
    const deps = {
      state: { currentProject: 'PiMemoryExtension', hasInjectedContext: false, sessionId: 1 },
      mem: vi.fn(async (cmd) => {
        if (cmd === 'context') {
          return {
            observations: [],
            personal: [],
            stats: { total_memories: 42, total_personal: 0, active_workflows: 0 },
            topic: null,
          };
        }
        if (cmd === 'preflight') {
          return {
            likely_existing_code: [{ symbol: 'saveUser', file: 'src/users.js', line: 4, kind: 'function' }],
            related_files: ['src/users.js'],
            duplicate_warnings: [],
            risk: 'medium',
            recommended_action: 'Review saveUser before editing.',
          };
        }
        if (cmd === 'coding-context') {
          return {
            target: { symbol: 'saveUser', file: 'src/users.js' },
            summary: { risk: 'medium', review_bar: 'normal-plus', affected_files: 2 },
            related_files: ['src/users.js', 'src/routes.js'],
            likely_tests: [{ file: 'test/users.test.js', reasons: ['imports target file'] }],
            partial_errors: [],
          };
        }
        return null;
      }),
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'PiMemoryExtension',
          path: process.cwd(),
          file_count: 292,
          symbol_count: 6913,
          indexed_at: '2026-05-24 00:00:00',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(false),
    };

    registerBeforeAgentStart(pi, deps);
    const prompt = 'fix saveUser so it validates input';
    const result = await handler({ prompt }, { cwd: process.cwd() });
    const content = result.message.content;

    expect(deps.mem).toHaveBeenCalledWith(
      'preflight',
      expect.objectContaining({ repo: 'PiMemoryExtension', task: prompt }),
    );
    expect(deps.mem).toHaveBeenCalledWith('coding-context', {
      repo: 'PiMemoryExtension',
      symbol: 'saveUser',
      depth: '2',
      top: '5',
    });
    expect(content).toContain('### Preflight — Before Coding');
    expect(content).toContain('### Coding Context — Before Editing');
    expect(content).toContain('Target: `saveUser`');
    expect(content).toContain('Likely tests: `test/users.test.js`');
  });
});

describe('preflight-worthiness detection', () => {
  test('triggers on coding action verbs', () => {
    expect(isPreflightWorthyPrompt('add notification preferences')).toBe(true);
    expect(isPreflightWorthyPrompt('create a new endpoint for auth')).toBe(true);
    expect(isPreflightWorthyPrompt('fix the memory leak in context injection')).toBe(true);
    expect(isPreflightWorthyPrompt('implement retry logic for failed requests')).toBe(true);
    expect(isPreflightWorthyPrompt('refactor the data access layer')).toBe(true);
    expect(isPreflightWorthyPrompt('update the CLI to support new flags')).toBe(true);
    expect(isPreflightWorthyPrompt('build a dashboard for monitoring')).toBe(true);
    expect(isPreflightWorthyPrompt('write a test for the new component')).toBe(true);
    expect(isPreflightWorthyPrompt('extract the common logic into a utility')).toBe(true);
  });

  test('triggers on feature/bug keywords', () => {
    expect(isPreflightWorthyPrompt('feature: support dark mode')).toBe(true);
    expect(isPreflightWorthyPrompt('bug: context injection fails on empty prompts')).toBe(true);
    expect(isPreflightWorthyPrompt('issue #42: migrate to new API')).toBe(true);
    expect(isPreflightWorthyPrompt('the test suite is failing')).toBe(true);
    expect(isPreflightWorthyPrompt('add a route for /api/health')).toBe(true);
  });

  test('triggers on intent phrases', () => {
    expect(isPreflightWorthyPrompt('make it so that the cache auto-clears')).toBe(true);
    expect(isPreflightWorthyPrompt('ensure all errors are logged')).toBe(true);
    expect(isPreflightWorthyPrompt('need to add validation')).toBe(true);
    expect(isPreflightWorthyPrompt("let's move the config to a separate package")).toBe(true);
    expect(isPreflightWorthyPrompt('I should add a guard clause here')).toBe(true);
  });

  test('does NOT trigger on navigation prompts', () => {
    expect(isPreflightWorthyPrompt('where is context injection implemented?')).toBe(false);
    expect(isPreflightWorthyPrompt('what module handles search?')).toBe(false);
    expect(isPreflightWorthyPrompt('show me the file path for the gateway')).toBe(false);
  });

  test('does NOT trigger on historical memory prompts', () => {
    expect(isPreflightWorthyPrompt('why did LaPis choose SQLite FTS5?')).toBe(false);
    expect(isPreflightWorthyPrompt('what was the rationale for the decision?')).toBe(false);
    expect(isPreflightWorthyPrompt('what bug led to the refactor?')).toBe(false);
  });

  test('does NOT trigger on source-authoritative prompts', () => {
    expect(isPreflightWorthyPrompt('In the current source, what does rankObservations do?')).toBe(false);
    expect(isPreflightWorthyPrompt('answer from the code')).toBe(false);
  });

  test('does NOT trigger on pure question prompts', () => {
    expect(isPreflightWorthyPrompt('what is LaPis?')).toBe(false);
    expect(isPreflightWorthyPrompt('how many tests are there?')).toBe(false);
    expect(isPreflightWorthyPrompt('does the extension support Windows?')).toBe(false);
    expect(isPreflightWorthyPrompt('can you explain the memory domain architecture?')).toBe(false);
    expect(isPreflightWorthyPrompt('tell me about the context injection flow')).toBe(false);
  });

  test('returns false for null/empty prompts', () => {
    expect(isPreflightWorthyPrompt(null)).toBe(false);
    expect(isPreflightWorthyPrompt('')).toBe(false);
  });
});
