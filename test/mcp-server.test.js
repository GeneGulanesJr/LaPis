// MCP server tests.
// Covers three layers:
//   1. tool catalog sanity (every tool has valid schema + working toCommand)
//   2. translate-result mapping (error/success/raw shapes → CallToolResult)
//   3. end-to-end through the SDK's InMemoryTransport with a fake dispatch,
//      Proving the server wires tools → dispatch → MCP framing correctly.
//
// Uses vitest globals (vitest.config.mjs: globals:true) — no import needed.

// --- catalog sanity ---

describe('MCP tool catalog', () => {
  const { tools, toolByName, CODE_MODE_TO_COMMAND, DOC_MODE_TO_COMMAND } = require('../src/mcp/tools');

  it('exposes the 11 expected tools', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'index-status',
        'memory-code',
        'memory-delete',
        'memory-doc',
        'memory-get',
        'memory-load-context',
        'memory-related',
        'memory-save',
        'memory-search',
        'memory-sync-code-trust',
        'memory-update',
      ].sort(),
    );
  });

  for (const tool of tools) {
    describe(`tool: ${tool.name}`, () => {
      it('has a valid JSON-schema inputSchema', () => {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeTypeOf('object');
        // Required, if present, must list known properties
        if (tool.inputSchema.required) {
          for (const r of tool.inputSchema.required) {
            expect(tool.inputSchema.properties[r], `required field "${r}" missing from properties`).toBeDefined();
          }
        }
      });

      it('toCommand returns a non-empty cmd for valid input', () => {
        // Provide enough params to satisfy tools with required fields.
        // Mode-bearing tools get a valid first mode.
        const sample = sampleParams(tool.name);
        const out = tool.toCommand(sample, { project: 'test-project' });
        expect(out.cmd, `${tool.name} should produce a cmd`).toBeTypeOf('string');
        expect(out.cmd.length).toBeGreaterThan(0);
        expect(out.args).toBeTypeOf('object');
      });
    });
  }

  it('memory-code toCommand maps every mode to a known dispatch command', () => {
    const t = toolByName['memory-code'];
    for (const mode of Object.keys(CODE_MODE_TO_COMMAND)) {
      const out = t.toCommand({ mode, repo: 'r' }, { project: 'p' });
      expect(out.cmd, `mode ${mode} → ${out.cmd}`).toBe(CODE_MODE_TO_COMMAND[mode]);
    }
  });

  it('memory-doc toCommand maps every mode to a known dispatch command', () => {
    const t = toolByName['memory-doc'];
    for (const mode of Object.keys(DOC_MODE_TO_COMMAND)) {
      const out = t.toCommand({ mode, repo: 'r' }, { project: 'p' });
      expect(out.cmd, `mode ${mode} → ${out.cmd}`).toBe(DOC_MODE_TO_COMMAND[mode]);
    }
  });

  it('memory-code rejects unknown mode', () => {
    const t = toolByName['memory-code'];
    const out = t.toCommand({ mode: 'bogus', repo: 'r' }, { project: 'p' });
    expect(out.cmd).toBeNull();
    expect(out.error).toMatch(/Unknown memory-code mode/);
  });

  it('memory-save injects project + defaults from ctx', () => {
    const t = toolByName['memory-save'];
    const out = t.toCommand({ title: 'T', content: 'C' }, { project: 'myproj' });
    expect(out.cmd).toBe('save');
    expect(out.args.project).toBe('myproj');
    expect(out.args.type).toBe('manual'); // Default
    expect(out.args.scope).toBe('project'); // Default
  });

  it('memory-save forwards optional kebab-case flags', () => {
    const t = toolByName['memory-save'];
    const out = t.toCommand(
      { title: 'T', content: 'C', topic_key: 'auth', force: true, expires_in: '7d' },
      { project: 'p' },
    );
    expect(out.args['topic-key']).toBe('auth');
    expect(out.args.force).toBe('true');
    expect(out.args['expires-in']).toBe('7d');
  });

  it('memory-code callers/callees map to call-hierarchy with direction', () => {
    const t = toolByName['memory-code'];
    expect(t.toCommand({ mode: 'callers', repo: 'r', symbol: 's' }, { project: 'p' }).args.direction).toBe('callers');
    expect(t.toCommand({ mode: 'callees', repo: 'r', symbol: 's' }, { project: 'p' }).args.direction).toBe('callees');
  });

  it('memory-code search uses max-results instead of top', () => {
    const t = toolByName['memory-code'];
    const out = t.toCommand({ mode: 'search', repo: 'r', query: 'q', top: 3 }, { project: 'p' });
    expect(out.args['max-results']).toBe('3');
    expect(out.args.top).toBeUndefined();
  });
});

// --- translate-result ---

describe('translate-result', () => {
  const { toCallToolResult, stripTuiArtifacts, truncate } = require('../src/mcp/translate-result');

  it('maps null to an error result', () => {
    const r = toCallToolResult(null);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No result/);
  });

  it('maps dispatch { error } envelope to an error result', () => {
    const r = toCallToolResult({ error: 'boom' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Error: boom/);
  });

  it('serializes plain objects as JSON text', () => {
    const r = toCallToolResult({ results: [{ id: 1, title: 'x' }] });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results[0].id).toBe(1);
  });

  it('passes through already-shaped content, stripping only leading icons', () => {
    const r = toCallToolResult({
      content: [{ type: 'text', text: '✅ Memory saved: hello world' }],
    });
    // Leading status icon stripped; mid-string text preserved.
    expect(r.content[0].text).toBe('Memory saved: hello world');
    expect(r.isError).toBeUndefined();
  });

  it('preserves isError=true on content-shaped results', () => {
    const r = toCallToolResult({
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    });
    expect(r.isError).toBe(true);
  });

  it('stripTuiArtifacts removes leading decorative icons (incl. variation selectors)', () => {
    expect(stripTuiArtifacts('✅ Memory saved')).toBe('Memory saved');
    expect(stripTuiArtifacts('⚠️ Warning')).toBe('Warning'); // U+26A0 + U+FE0F
    expect(stripTuiArtifacts('📦 Indexing…')).toBe('Indexing…');
    expect(stripTuiArtifacts('plain text')).toBe('plain text');
  });

  it('stripTuiArtifacts preserves mid-string emoji in data values', () => {
    // Only LEADING icons are stripped — emoji inside content may be meaningful.
    expect(stripTuiArtifacts('Memory: use ✅ for success')).toBe('Memory: use ✅ for success');
  });

  it('truncate caps very long output', () => {
    const long = 'x'.repeat(100);
    const r = toCallToolResult({ big: 'y'.repeat(200000) });
    expect(r.content[0].text.length).toBeLessThan(200000);
    expect(r.content[0].text).toMatch(/truncated/);
    // Helper itself
    expect(truncate(long, 10).length).toBeLessThanOrEqual(80); // Includes suffix
  });
});

// --- end-to-end through SDK InMemoryTransport ---

describe('MCP server end-to-end (InMemoryTransport)', () => {
  it('lists all tools and calls memory-save → dispatch → result', async () => {
    vi.resetModules();

    // Fake dispatch: records calls, returns canned responses keyed by cmd.
    const calls = [];
    const fakeDispatch = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'save') {
        return { id: 42, title: args.title, saved: true };
      }
      if (cmd === 'search') {
        return { results: [{ id: 42, title: 'T', type: 'decision', snippet: 'S', _score: 0.9 }] };
      }
      return { ok: true };
    };

    const { createServer } = require('../src/mcp/server');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

    const server = createServer({ dispatch: fakeDispatch, project: 'e2e-project' });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Tools/list
    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);
    expect(toolNames).toContain('memory-save');
    expect(toolNames).toContain('memory-search');
    expect(toolsList.tools.find((t) => t.name === 'memory-save').inputSchema.type).toBe('object');

    // Tools/call — save
    const saveResult = await client.callTool({
      name: 'memory-save',
      arguments: { title: 'My Decision', content: 'Use X because Y' },
    });
    expect(saveResult.isError).toBeUndefined();
    const parsed = JSON.parse(saveResult.content[0].text);
    expect(parsed.id).toBe(42);
    expect(parsed.title).toBe('My Decision');

    // Dispatch received the project-scoped args
    expect(calls[0].cmd).toBe('save');
    expect(calls[0].args.project).toBe('e2e-project');

    // Tools/call — search returns serialized object
    const searchResult = await client.callTool({ name: 'memory-search', arguments: { query: 'decisions' } });
    const searchParsed = JSON.parse(searchResult.content[0].text);
    expect(searchParsed.results[0].id).toBe(42);

    // Unknown tool → error
    const unknownResult = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(unknownResult.isError).toBe(true);
    expect(unknownResult.content[0].text).toMatch(/Unknown tool/);

    // Unknown memory-code mode → error
    const badMode = await client.callTool({ name: 'memory-code', arguments: { mode: 'not-a-mode' } });
    expect(badMode.isError).toBe(true);

    server.close?.();
    client.close?.();
  });

  it('translates dispatch { error } into an MCP error result', async () => {
    vi.resetModules();
    const fakeDispatch = async () => ({ error: 'repo not indexed' });
    const { createServer } = require('../src/mcp/server');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

    const server = createServer({ dispatch: fakeDispatch, project: 'p' });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({ name: 'memory-search', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/repo not indexed/);

    server.close?.();
    client.close?.();
  });

  it('projectFromCwd derives project from a directory basename', () => {
    const { projectFromCwd } = require('../src/mcp/server');
    expect(projectFromCwd('/home/user/MyProject')).toBe('myproject');
    expect(projectFromCwd('/tmp/lapis-test')).toBe('lapis-test');
  });

  it('detectMcpProject prefers indexed repo path over cwd basename', () => {
    const dbPath = require.resolve('../db');
    const realDb = require(dbPath);
    const prev = require.cache[dbPath].exports;
    require.cache[dbPath].exports = {
      ...realDb,
      sqlJson: (sql) => {
        if (sql.includes('code_repos')) {
          return [{ name: 'my-monorepo', path: '/repos/my-monorepo', indexed_at: '2026-01-01' }];
        }
        if (sql.includes('FROM observations')) {
          return [];
        }
        return realDb.sqlJson ? realDb.sqlJson(sql) : [];
      },
    };
    try {
      const { detectMcpProject } = require('../src/mcp/server');
      expect(detectMcpProject('/repos/my-monorepo/packages/foo')).toBe('my-monorepo');
    } finally {
      require.cache[dbPath].exports = prev;
    }
  });
});

// --- startMcpServer error handling ---

describe('startMcpServer', () => {
  it('writes to stderr and exits non-zero when ensureDb() throws', async () => {
    // Swap the cached db module for one whose ensureDb() throws so we
    // Exercise the real error path without touching the real DB.
    const dbPath = require.resolve('../db');
    // Ensure the module is cached so we can swap its exports.
    require(dbPath);
    const realDb = require.cache[dbPath].exports;
    require.cache[dbPath].exports = {
      ensureDb: () => {
        throw new Error('EACCES: ~/.lapis unwritable');
      },
    };

    const stderrChunks = [];
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    const realExit = process.exit;
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };
    let exitCode = null;
    process.exit = (code) => {
      exitCode = code;
      // Throw to unwind startMcpServer before it reaches server.connect()
      throw new Error(`__synthetic_exit_${code}__`);
    };

    const { startMcpServer } = require('../src/mcp/server');
    let thrown = null;
    try {
      await startMcpServer();
    } catch (err) {
      thrown = err;
    } finally {
      process.stderr.write = realStderrWrite;
      process.exit = realExit;
      require.cache[dbPath].exports = realDb;
    }

    expect(thrown, 'startMcpServer should propagate the synthetic exit signal').not.toBeNull();
    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toMatch(/lapis mcp: database initialization failed/);
    expect(stderrChunks.join('')).toMatch(/EACCES/);
  });
});

// --- helper ---

function sampleParams(name) {
  switch (name) {
    case 'memory-save':
      return { title: 'T', content: 'C' };
    case 'memory-search':
      return { query: 'q' };
    case 'memory-get':
    case 'memory-delete':
    case 'memory-related':
      return { id: 1 };
    case 'memory-update':
      return { id: 1, title: 'T' };
    case 'memory-load-context':
      return { query: 'q' };
    case 'memory-code':
      return { mode: 'outline', repo: 'r', file: 'src/foo.ts' };
    case 'memory-doc':
      return { mode: 'search', repo: 'r', query: 'q' };
    case 'memory-sync-code-trust':
      return { repo: 'r' };
    case 'index-status':
      return { job: 'j1' };
    default:
      return {};
  }
}
