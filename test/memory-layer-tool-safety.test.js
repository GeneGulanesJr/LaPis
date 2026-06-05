import { describe, expect, it, vi } from 'vitest';
import {
  normalizeToolResult,
  toolProgressResult,
  toolTextResult,
} from '../extensions/memory-layer/tools/tool-result.ts';
import { formatCodeResult } from '../extensions/memory-layer/tools/format-code-result.ts';
import { registerCodeTools } from '../extensions/memory-layer/tools/code-tools.ts';
import { registerDocTools } from '../extensions/memory-layer/tools/doc-tools.ts';
import { registerMemoryTools } from '../extensions/memory-layer/tools/memory-tools.ts';
import { registerToolGuardrails } from '../extensions/memory-layer/hooks/tool-guardrails.ts';
import { renderCompactToolResult } from '../extensions/memory-layer/tools/render.ts';

function captureTool(register, deps) {
  let registered;
  register(
    {
      registerTool(tool) {
        registered = tool;
      },
      registerCommand() {},
    },
    deps,
  );
  if (!registered) {
    throw new Error('tool was not registered');
  }
  return registered;
}

function captureNamedTool(register, deps, toolName) {
  let registered;
  register(
    {
      registerTool(tool) {
        if (tool.name === toolName) {
          registered = tool;
        }
      },
      registerCommand() {},
    },
    deps,
  );
  if (!registered) {
    throw new Error(`${toolName} tool was not registered`);
  }
  return registered;
}

function expectRenderable(result) {
  expect(result).toBeTruthy();
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content.length).toBeGreaterThan(0);
  expect(result.content.every((item) => item && typeof item === 'object')).toBe(true);
  expect(result.content.filter((item) => item.type === 'text').every((item) => typeof item.text === 'string')).toBe(
    true,
  );
  expect(result.details).toBeTruthy();
  expect(typeof result.details).toBe('object');
}

function captureHook(register, deps, eventName) {
  let registered;
  register(
    {
      on(name, handler) {
        if (name === eventName) {
          registered = handler;
        }
      },
    },
    deps,
  );
  if (!registered) {
    throw new Error(`${eventName} hook was not registered`);
  }
  return registered;
}

describe('memory tool renderer safety', () => {
  it('keeps full tool content while limiting terminal result previews', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = normalizeToolResult({ content: [{ type: 'text', text }], details: { full: true } });
    const theme = { fg: (_name, value) => value };

    const collapsed = renderCompactToolResult(result, { expanded: false }, theme).render(120).join('\n');
    const expanded = renderCompactToolResult(result, { expanded: true }, theme).render(120).join('\n');

    expect(result.content[0].text).toBe(text);
    expect(collapsed).toContain('line 1');
    expect(collapsed).toContain('line 2');
    expect(collapsed).not.toContain('line 3');
    expect(collapsed).toContain('18 more terminal lines hidden');
    expect(expanded).toContain('line 20');
  });

  it('blocks accidental memory-get content from another project unless explicitly allowed', async () => {
    const tool = captureNamedTool(
      registerMemoryTools,
      {
        state: { currentProject: 'PiMemoryExtension' },
        mem: vi.fn().mockResolvedValue({
          id: 2,
          title: 'Other project memory',
          type: 'decision',
          scope: 'project',
          project: 'Aelvyril',
          content: 'large unrelated content',
        }),
        memCmd: vi.fn(),
        trustIcon: vi.fn(),
      },
      'memory-get',
    );

    const blocked = await tool.execute('id', { id: 2 }, undefined, vi.fn(), {});
    const allowed = await tool.execute('id', { id: 2, allow_cross_project: true }, undefined, vi.fn(), {});

    expectRenderable(blocked);
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain('belongs to project "Aelvyril"');
    expect(blocked.content[0].text).not.toContain('large unrelated content');
    expectRenderable(allowed);
    expect(allowed.isError).not.toBe(true);
    expect(allowed.content[0].text).toContain('large unrelated content');
  });

  it('normalizes malformed results into Pi-renderable text results', () => {
    expectRenderable(normalizeToolResult(undefined));
    expectRenderable(normalizeToolResult({}));
    expectRenderable(normalizeToolResult({ content: undefined, details: undefined }));
    expectRenderable(toolTextResult(null));
    expectRenderable(toolProgressResult('Indexing src/app.ts'));
  });

  it('keeps memory-code streaming updates renderable during indexing', async () => {
    const onUpdate = vi.fn();
    const tool = captureTool(registerCodeTools, {
      mem: vi.fn(),
      memStreaming: vi.fn(async (_cmd, _args, emit) => {
        emit('Indexing src/app.ts');
        return { name: 'app', file_count: 1, symbol_count: 2 };
      }),
      getKnownRepos: vi.fn(),
      formatCodeResult: vi.fn(() => 'Indexed app.'),
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute('id', { mode: 'reindex-repo', path: '.', name: 'app' }, undefined, onUpdate, {});

    expectRenderable(result);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expectRenderable(onUpdate.mock.calls[0][0]);
  });

  it.each([
    ['bare command', {}],
    ['unknown mode', { mode: 'wat' }],
    ['missing repo', { mode: 'outline' }],
    ['missing symbol', { mode: 'callers', repo: 'app' }],
    ['missing file', { mode: 'outline', repo: 'app' }],
    ['missing index path', { mode: 'index-repo' }],
  ])('keeps memory-code renderable for %s', async (_name, params) => {
    const tool = captureTool(registerCodeTools, {
      mem: vi.fn(),
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([]),
      formatCodeResult: vi.fn(),
    });

    const result = await tool.execute('id', params, undefined, vi.fn(), {});
    expectRenderable(result);
  });

  it('keeps memory-code renderable for unindexed repos, empty backend output, backend errors, formatter failures, and thrown exceptions', async () => {
    const cases = [
      {
        name: 'unindexed repo',
        deps: {
          mem: vi.fn(),
          memStreaming: vi.fn(),
          getKnownRepos: vi.fn().mockResolvedValue([]),
          formatCodeResult: vi.fn(),
        },
        params: { mode: 'deps', repo: 'app' },
      },
      {
        name: 'empty backend output',
        deps: {
          mem: vi.fn().mockResolvedValue(undefined),
          memStreaming: vi.fn(),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
          formatCodeResult: vi.fn(),
        },
        params: { mode: 'deps', repo: 'app' },
      },
      {
        name: 'backend error',
        deps: {
          mem: vi.fn().mockResolvedValue({ error: 'boom' }),
          memStreaming: vi.fn(),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
          formatCodeResult: vi.fn(),
        },
        params: { mode: 'deps', repo: 'app' },
      },
      {
        name: 'formatter failure',
        deps: {
          mem: vi.fn().mockResolvedValue({ edges: [] }),
          memStreaming: vi.fn(),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
          formatCodeResult: vi.fn(() => {
            throw new Error('format failed');
          }),
        },
        params: { mode: 'deps', repo: 'app' },
      },
      {
        name: 'backend throw',
        deps: {
          mem: vi.fn(() => {
            throw new Error('db locked');
          }),
          memStreaming: vi.fn(),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
          formatCodeResult: vi.fn(),
        },
        params: { mode: 'deps', repo: 'app' },
      },
      {
        name: 'indexing empty output',
        deps: {
          mem: vi.fn(),
          memStreaming: vi.fn().mockResolvedValue(undefined),
          getKnownRepos: vi.fn(),
          formatCodeResult: vi.fn(),
        },
        params: { mode: 'reindex-repo', path: '.', name: 'app' },
      },
    ];

    const results = await Promise.all(
      cases.map((testCase) => {
        const tool = captureTool(registerCodeTools, testCase.deps);
        return tool.execute('id', testCase.params, undefined, vi.fn(), {});
      }),
    );

    results.forEach(expectRenderable);
  });

  it('caps memory-code outline details before returning them to the agent', async () => {
    const classes = Array.from({ length: 30 }, (_classItem, classIndex) => ({
      name: `Class${classIndex}`,
      methods: Array.from({ length: 40 }, (_methodItem, methodIndex) => ({
        name: `method${methodIndex}`,
        kind: 'method',
      })),
    }));
    const standalone = Array.from({ length: 120 }, (_, index) => ({ name: `fn${index}`, kind: 'function' }));
    const tool = captureTool(registerCodeTools, {
      mem: vi.fn().mockResolvedValue({ file: 'src', classes, standalone }),
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
      formatCodeResult: vi.fn(() => 'File outline'),
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute('id', { mode: 'outline', repo: 'app', file: 'src' }, undefined, vi.fn(), {});

    expectRenderable(result);
    expect(result.details.classes.length).toBe(20);
    expect(result.details.classes[0].methods.length).toBe(25);
    expect(result.details.standalone.length).toBe(80);
    expect(result.details.truncated).toBe(true);
  });

  it('unwraps and caps enveloped memory-code outline results before formatting', async () => {
    const standalone = Array.from({ length: 120 }, (_item, index) => ({
      name: `fn${index}`,
      kind: 'function',
      signature: `function fn${index}() {}`,
    }));
    const tool = captureTool(registerCodeTools, {
      mem: vi.fn().mockResolvedValue({
        _meta: { result_count: 120, freshness: 'stale_index' },
        data: { file: 'src/large.js', classes: [], standalone },
      }),
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
      formatCodeResult,
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute(
      'id',
      { mode: 'outline', repo: 'app', file: 'src/large.js' },
      undefined,
      vi.fn(),
      {},
    );
    const text = result.content.find((item) => item.type === 'text').text;

    expectRenderable(result);
    expect(text).toContain('File outline');
    expect(text).toContain('fn79');
    expect(text).not.toContain('fn80');
    expect(result.details._meta.result_count).toBe(120);
    expect(result.details.data.standalone.length).toBe(80);
    expect(result.details.data.truncated).toBe(true);
  });

  it('supports memory-code search mode using query or symbol text', async () => {
    const mem = vi.fn().mockResolvedValue({
      query: 'context command',
      results: [{ symbol: 'context', file: 'src/memory-domain/context.js', line: 4 }],
    });
    const tool = captureTool(registerCodeTools, {
      mem,
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
      formatCodeResult,
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute(
      'id',
      { mode: 'search', repo: 'app', symbol: 'context command' },
      undefined,
      vi.fn(),
      {},
    );
    const text = result.content.find((item) => item.type === 'text').text;

    expectRenderable(result);
    expect(mem).toHaveBeenCalledWith('search-code', {
      repo: 'app',
      symbol: 'context command',
      query: 'context command',
      'max-results': '5',
    });
    expect(text).toContain('Code search');
    expect(text).toContain('src/memory-domain/context.js');
  });

  it('infers memory-code repo from current working directory', async () => {
    const mem = vi.fn().mockResolvedValue({
      query: 'context command',
      results: [{ symbol: 'context', file: 'src/memory-domain/context.js', line: 4 }],
    });
    const tool = captureTool(registerCodeTools, {
      mem,
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app', path: process.cwd() }]),
      formatCodeResult,
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute('id', { mode: 'search', query: 'context command' }, undefined, vi.fn(), {});
    const text = result.content.find((item) => item.type === 'text').text;

    expectRenderable(result);
    expect(mem).toHaveBeenCalledWith('search-code', {
      repo: 'app',
      query: 'context command',
      'max-results': '5',
    });
    expect(text).toContain('Code search');
  });

  it('supports memory-code preflight mode with task text', async () => {
    const mem = vi.fn().mockResolvedValue({
      task_summary: 'add notification preferences',
      risk: 'medium',
      duplicate_risk: 'medium',
      recommended_action: 'Review existing getNotificationPreferences before creating new code.',
      likely_existing_code: [{ symbol: 'getNotificationPreferences', file: 'src/preferences.js', line: 1 }],
      similar_past_tasks: [],
      related_files: ['src/preferences.js'],
      duplicate_warnings: [{ symbol: 'getNotificationPreferences', file: 'src/preferences.js' }],
    });
    const tool = captureTool(registerCodeTools, {
      mem,
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
      formatCodeResult,
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute(
      'id',
      { mode: 'preflight', repo: 'app', task: 'add notification preferences' },
      undefined,
      vi.fn(),
      {},
    );
    const text = result.content.find((item) => item.type === 'text').text;

    expectRenderable(result);
    expect(mem).toHaveBeenCalledWith('preflight', {
      repo: 'app',
      task: 'add notification preferences',
    });
    expect(text).toContain('Preflight');
    expect(text).toContain('getNotificationPreferences');
  });

  it('supports memory-code coding-context mode for a symbol', async () => {
    const mem = vi.fn().mockResolvedValue({
      repo: 'app',
      target: { symbol: 'saveUser', file: 'src/users.js' },
      summary: { risk: 'medium', review_bar: 'normal-plus', affected_files: 2, reasons: ['multiple callers'] },
      related_files: ['src/users.js', 'test/users.test.js'],
      likely_tests: [{ file: 'test/users.test.js', reasons: ['imports target file'] }],
      recommended_next: ['Read targeted lines in src/users.js.'],
      partial_errors: [],
    });
    const tool = captureTool(registerCodeTools, {
      mem,
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app' }]),
      formatCodeResult,
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute(
      'id',
      { mode: 'coding-context', repo: 'app', symbol: 'saveUser', depth: 2, top: 5 },
      undefined,
      vi.fn(),
      {},
    );
    const text = result.content.find((item) => item.type === 'text').text;

    expectRenderable(result);
    expect(mem).toHaveBeenCalledWith('coding-context', {
      repo: 'app',
      symbol: 'saveUser',
      depth: '2',
      top: '5',
    });
    expect(text).toContain('Coding context');
    expect(text).toContain('saveUser');
    expect(text).toContain('test/users.test.js');
  });

  it('infers memory-code repo when only one indexed repo is available', async () => {
    const mem = vi.fn().mockResolvedValue({
      query: 'rankObservations',
      results: [{ symbol: 'rankObservations', file: 'src/memory-domain/search.js', line: 23 }],
    });
    const tool = captureTool(registerCodeTools, {
      mem,
      memStreaming: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([{ name: 'solo', path: '/tmp/other' }]),
      formatCodeResult,
      invalidateRepoCache: vi.fn(),
    });

    const result = await tool.execute('id', { mode: 'search', query: 'rankObservations' }, undefined, vi.fn(), {});

    expectRenderable(result);
    expect(mem).toHaveBeenCalledWith('search-code', {
      repo: 'solo',
      query: 'rankObservations',
      'max-results': '5',
    });
  });

  it('blocks raw repository discovery commands in indexed repos', async () => {
    const toolCall = captureHook(
      registerToolGuardrails,
      {
        state: {
          currentProject: 'app',
          lastMemoryToolCall: 0,
          callsSinceLastMemory: 0,
          exploredFiles: new Set(),
        },
        getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app', path: process.cwd() }]),
        isCodeFile: vi.fn(),
        memStreaming: vi.fn(),
        invalidateRepoCache: vi.fn(),
      },
      'tool_call',
    );

    const result = await toolCall(
      {
        toolName: 'bash',
        input: { command: "find . -maxdepth 3 -type f | grep -E 'memory|context|domain' | head -200" },
      },
      { ui: { notify: vi.fn() } },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain('Raw repository search detected');
    expect(result.reason).toContain('memory-code search');
  });

  it('allows grep when it only filters another command output', async () => {
    const toolCall = captureHook(
      registerToolGuardrails,
      {
        state: {
          currentProject: 'app',
          lastMemoryToolCall: 0,
          callsSinceLastMemory: 0,
          exploredFiles: new Set(),
        },
        getKnownRepos: vi.fn().mockResolvedValue([{ name: 'app', path: process.cwd() }]),
        isCodeFile: vi.fn(),
        memStreaming: vi.fn(),
        invalidateRepoCache: vi.fn(),
      },
      'tool_call',
    );

    const result = await toolCall(
      {
        toolName: 'bash',
        input: { command: 'npx oxlint 2>&1 | grep -iE "(lowercase|Unused)" || true' },
      },
      { ui: { notify: vi.fn() } },
    );

    expect(result).toBeUndefined();
  });

  it.each([
    ['bare command', {}],
    ['unknown mode', { mode: 'wat' }],
    ['missing repo', { mode: 'search' }],
    ['missing query', { mode: 'search', repo: 'docs' }],
    ['missing backlinks path', { mode: 'backlinks', repo: 'docs' }],
    ['missing index path', { mode: 'index-docs' }],
  ])('keeps memory-doc renderable for %s', async (_name, params) => {
    const tool = captureTool(registerDocTools, {
      mem: vi.fn(),
      getKnownRepos: vi.fn().mockResolvedValue([]),
      formatDocResult: vi.fn(),
    });

    const result = await tool.execute('id', params, undefined, vi.fn(), {});
    expectRenderable(result);
  });

  it('keeps memory-doc renderable for unindexed repos, empty backend output, backend errors, formatter failures, and thrown exceptions', async () => {
    const cases = [
      {
        deps: {
          mem: vi.fn(),
          getKnownRepos: vi.fn().mockResolvedValue([]),
          formatDocResult: vi.fn(),
        },
        params: { mode: 'outline', repo: 'docs' },
      },
      {
        deps: {
          mem: vi.fn().mockResolvedValue(undefined),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'docs' }]),
          formatDocResult: vi.fn(),
        },
        params: { mode: 'outline', repo: 'docs' },
      },
      {
        deps: {
          mem: vi.fn().mockResolvedValue({ error: 'boom' }),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'docs' }]),
          formatDocResult: vi.fn(),
        },
        params: { mode: 'outline', repo: 'docs' },
      },
      {
        deps: {
          mem: vi.fn().mockResolvedValue({ headings: [] }),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'docs' }]),
          formatDocResult: vi.fn(() => {
            throw new Error('format failed');
          }),
        },
        params: { mode: 'outline', repo: 'docs' },
      },
      {
        deps: {
          mem: vi.fn(() => {
            throw new Error('db locked');
          }),
          getKnownRepos: vi.fn().mockResolvedValue([{ name: 'docs' }]),
          formatDocResult: vi.fn(),
        },
        params: { mode: 'outline', repo: 'docs' },
      },
      {
        deps: {
          mem: vi.fn().mockResolvedValue(undefined),
          getKnownRepos: vi.fn(),
          formatDocResult: vi.fn(),
        },
        params: { mode: 'reindex-docs', path: 'docs', name: 'docs' },
      },
    ];

    const results = await Promise.all(
      cases.map((testCase) => {
        const tool = captureTool(registerDocTools, testCase.deps);
        return tool.execute('id', testCase.params, undefined, vi.fn(), {});
      }),
    );

    results.forEach(expectRenderable);
  });
});
