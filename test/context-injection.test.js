import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFilePaths, registerBeforeAgentStart } from '../extensions/memory-layer/hooks/context-injection.ts';

/**
 * Extract the handler registered by registerBeforeAgentStart
 */
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

function buildDeps(overrides = {}) {
  return {
    state: { currentProject: 'TestProject', hasInjectedContext: false, sessionId: 1 },
    mem: vi.fn().mockResolvedValue({
      observations: [],
      personal: [],
      stats: { total_memories: 42, total_personal: 1, active_workflows: 0 },
      topic: null,
    }),
    getKnownRepos: vi.fn().mockResolvedValue([]),
    isRepoStale: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe('rich context injection', () => {
  test('produces structured format with Memory Context heading', async () => {
    const deps = buildDeps();
    const handler = extractHandler(deps);

    const result = await handler({}, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('## Memory Context (auto-loaded)');
    expect(content).toContain('### Project Context');
    expect(content).toContain('Project: **TestProject**');
  });

  test('includes project summary from package.json', async () => {
    const deps = buildDeps();
    const handler = extractHandler(deps);

    const result = await handler({}, { cwd: process.cwd() });
    const content = result.message.content;

    // LaPis package.json has a description
    expect(content).toContain('LaPis');
  });

  test('includes code index details when repo is known', async () => {
    const deps = buildDeps({
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'TestRepo',
          path: process.cwd(),
          file_count: 100,
          symbol_count: 500,
          indexed_at: '2026-05-29T00:00:00Z',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(false),
    });
    const handler = extractHandler(deps);

    const result = await handler({}, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('Code index: `TestRepo`');
    expect(content).toContain('100 files');
    expect(content).toContain('500 symbols');
  });

  test('shows stale label when index is stale', async () => {
    const deps = buildDeps({
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'TestRepo',
          path: process.cwd(),
          file_count: 100,
          symbol_count: 500,
          indexed_at: '2026-05-01T00:00:00Z',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(true),
    });
    const handler = extractHandler(deps);

    const result = await handler({}, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('(stale)');
  });

  test('injects prompt-matched memory with inline content', async () => {
    const deps = buildDeps({
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'decision',
            title: 'Use SQLite FTS5',
            trust_score: 0.95,
            content: '**What**: Use FTS5\n**Why**: No external deps\n**Where**: search.js',
          },
        ],
        personal: [],
        stats: { total_memories: 10, total_personal: 0, active_workflows: 0 },
        topic: 'fts5',
      }),
    });
    const handler = extractHandler(deps);

    const result = await handler({ prompt: 'why fts5' }, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('### Prompt-Matched Memory');
    expect(content).toContain('[decision] Use SQLite FTS5');
    expect(content).toContain('What: Use FTS5 Why: No external deps Where: search.js');
  });

  test('suppresses stale warning for historical prompts', async () => {
    const deps = buildDeps({
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'architecture',
            title: 'FTS5 rationale',
            trust_score: 0.95,
            content: '**Why**: Performance',
          },
        ],
        personal: [],
        stats: { total_memories: 10, total_personal: 0, active_workflows: 0 },
        topic: 'fts5',
      }),
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'TestRepo',
          path: process.cwd(),
          file_count: 100,
          symbol_count: 500,
          indexed_at: '2026-05-01T00:00:00Z',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(true),
    });
    const handler = extractHandler(deps);

    const result = await handler({ prompt: 'Why did we choose SQLite?' }, { cwd: process.cwd() });
    const content = result.message.content;

    // (stale) label is suppressed because agent has prompt-matched observation
    // STALE_GUIDANCE block is also suppressed (historical prompt + has observations)
    expect(content).not.toContain('(stale)');
    expect(content).not.toContain('Stale code index');
    expect(content).not.toContain('reindex');
  });

  test('shows stale guidance block for non-historical prompts', async () => {
    const deps = buildDeps({
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'TestRepo',
          path: process.cwd(),
          file_count: 100,
          symbol_count: 500,
          indexed_at: '2026-05-01T00:00:00Z',
        },
      ]),
      isRepoStale: vi.fn().mockReturnValue(true),
    });
    const handler = extractHandler(deps);

    const result = await handler({ prompt: 'refactor the context module' }, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('Stale code index');
    expect(content).toContain('reindex');
  });

  test('new project format shows cross-project context', async () => {
    const callCount = { n: 0 };
    const deps = buildDeps({
      mem: vi.fn().mockImplementation(() => {
        callCount.n++;
        // First call (project-specific) returns null → triggers cross-project
        if (callCount.n === 1) {
          return null;
        }
        return {
          observations: [],
          personal: [],
          stats: { total_memories: 5, total_personal: 0, active_workflows: 0 },
          topic: null,
        };
      }),
    });
    const handler = extractHandler(deps);

    const result = await handler({}, { cwd: process.cwd() });
    const content = result.message.content;

    expect(content).toContain('new project');
  });

  test('personal preferences are not injected when PERSONAL_INJECT_LIMIT is 0', async () => {
    const deps = buildDeps({
      mem: vi.fn().mockResolvedValue({
        observations: [],
        personal: [{ id: 1, title: 'Use tabs not spaces', type: 'preference' }],
        stats: { total_memories: 10, total_personal: 1, active_workflows: 0 },
        topic: null,
      }),
    });
    const handler = extractHandler(deps);

    const result = await handler({ prompt: 'format code' }, { cwd: process.cwd() });
    const content = result.message.content;

    // PERSONAL_INJECT_LIMIT = 0, so no personal section appears
    expect(content).not.toContain('### Personal Preferences');
    expect(content).not.toContain('Use tabs not spaces');
  });

  test('caps injected context size while preserving essential memory details', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-context-cap-'));
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ description: `LaPis ${'very long project summary '.repeat(200)}` }),
    );
    const deps = buildDeps({
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'decision',
            title: 'Use SQLite FTS5',
            trust_score: 0.95,
            content: `**What**: Use FTS5 ${'extra detail '.repeat(100)}\n**Why**: No external deps ${'extra detail '.repeat(100)}\n**Where**: src/memory-domain/search.js`,
          },
        ],
        personal: [],
        stats: { total_memories: 10, total_personal: 0, active_workflows: 0 },
        topic: 'fts5',
      }),
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'TestRepo',
          path: tempDir,
          file_count: 100,
          symbol_count: 500,
          indexed_at: '2026-05-29T00:00:00Z',
        },
      ]),
    });
    const handler = extractHandler(deps);

    const result = await handler({ prompt: 'why fts5' }, { cwd: tempDir });
    const content = result.message.content;

    expect(content.length).toBeLessThanOrEqual(1800);
    expect(content).toContain('Project: **TestRepo**');
    expect(content).toContain('[decision] Use SQLite FTS5');
    expect(content).toContain('What: Use FTS5');
  });

  test('self-heals stale currentProject when path-resolved repo name differs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-self-heal-rename-'));
    const deps = buildDeps({
      state: { currentProject: 'work', hasInjectedContext: false, sessionId: 1 },
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'netcrawl',
          path: tempDir,
          file_count: 10,
          symbol_count: 50,
          indexed_at: '2026-05-29T00:00:00Z',
        },
      ]),
    });
    const handler = extractHandler(deps);

    await handler({}, { cwd: tempDir });

    expect(deps.state.currentProject).toBe('netcrawl');
  });

  test('does not self-heal to a parent repo when cwd is inside a nested child repo', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-self-heal-nested-'));
    const parentDir = path.join(root, 'work');
    const childDir = path.join(parentDir, 'netcrawl');
    fs.mkdirSync(childDir, { recursive: true });
    const deps = buildDeps({
      state: { currentProject: 'netcrawl', hasInjectedContext: false, sessionId: 1 },
      getKnownRepos: vi.fn().mockResolvedValue([
        {
          name: 'work',
          path: parentDir,
          file_count: 100,
          symbol_count: 500,
          indexed_at: '2026-05-29T00:00:00Z',
        },
        {
          name: 'netcrawl',
          path: childDir,
          file_count: 20,
          symbol_count: 80,
          indexed_at: '2026-05-29T00:00:00Z',
        },
      ]),
    });
    const handler = extractHandler(deps);

    await handler({}, { cwd: childDir });

    expect(deps.state.currentProject).toBe('netcrawl');
  });

  test('navigation prompts can include two related memories but no more', async () => {
    const deps = buildDeps({
      mem: vi.fn().mockResolvedValue({
        observations: [
          {
            type: 'architecture',
            title: 'Context hook module',
            trust_score: 0.95,
            content: '**Where**: extensions/memory-layer/hooks/context-injection.ts wires startup context',
          },
          {
            type: 'architecture',
            title: 'Extension composition module',
            trust_score: 0.95,
            content: '**Where**: extensions/memory-layer/index.ts registers the hooks',
          },
          {
            type: 'architecture',
            title: 'Extra unrelated memory',
            trust_score: 0.95,
            content: '**Where**: src/extra.js should not be injected',
          },
        ],
        personal: [],
        stats: { total_memories: 10, total_personal: 0, active_workflows: 0 },
        topic: 'context hook',
      }),
    });
    const handler = extractHandler(deps);

    const result = await handler(
      { prompt: 'Where is automatic project memory context wired?' },
      { cwd: process.cwd() },
    );
    const content = result.message.content;

    expect(content).toContain('[architecture] Context hook module');
    expect(content).toContain('[architecture] Extension composition module');
    expect(content).not.toContain('Extra unrelated memory');
  });
});

describe('extractFilePaths', () => {
  it('should extract file paths from memory content', () => {
    const content =
      '**What**: Search module\n**Why**: FTS5\n**Where**: src/memory-domain/search.js handles FTS5 queries';
    const paths = extractFilePaths(content);
    expect(paths).toContain('src/memory-domain/search.js');
  });

  it('should extract multiple paths and deduplicate', () => {
    const content =
      '**Where**: src/memory-domain/search.js and src/memory-domain/context.js also uses src/memory-domain/search.js';
    const paths = extractFilePaths(content);
    expect(paths).toEqual(['src/memory-domain/search.js', 'src/memory-domain/context.js']);
  });

  it('should limit to 3 paths', () => {
    const content = 'src/a.js src/b.js src/c.js src/d.js src/e.js';
    const paths = extractFilePaths(content);
    expect(paths.length).toBe(3);
  });

  it('should return empty array for content without paths', () => {
    const paths = extractFilePaths('No file paths here, just a decision about architecture.');
    expect(paths).toEqual([]);
  });

  it('should ignore short strings without slashes', () => {
    const paths = extractFilePaths('Used test.js in the project');
    expect(paths).toEqual([]);
  });

  it('should extract paths from backtick-wrapped content', () => {
    const content = 'Module is `src/code-index/scanner.js` and also `src/code-index/parser-registry.js`';
    const paths = extractFilePaths(content);
    expect(paths).toContain('src/code-index/scanner.js');
    expect(paths).toContain('src/code-index/parser-registry.js');
  });
});
