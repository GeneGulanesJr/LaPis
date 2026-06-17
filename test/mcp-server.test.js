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

  it('exposes the 10 expected tools', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'index_status',
        'memory_code',
        'memory_delete',
        'memory_doc',
        'memory_get',
        'memory_load_context',
        'memory_related',
        'memory_save',
        'memory_search',
        'memory_sync_code_trust',
        'memory_update',
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

  it('memory_code toCommand maps every mode to a known dispatch command', () => {
    const t = toolByName.memory_code;
    for (const mode of Object.keys(CODE_MODE_TO_COMMAND)) {
      const out = t.toCommand({ mode, repo: 'r' }, { project: 'p' });
      expect(out.cmd, `mode ${mode} → ${out.cmd}`).toBe(CODE_MODE_TO_COMMAND[mode]);
    }
  });

  it('memory_doc toCommand maps every mode to a known dispatch command', () => {
    const t = toolByName.memory_doc;
    for (const mode of Object.keys(DOC_MODE_TO_COMMAND)) {
      const out = t.toCommand({ mode, repo: 'r' }, { project: 'p' });
      expect(out.cmd, `mode ${mode} → ${out.cmd}`).toBe(DOC_MODE_TO_COMMAND[mode]);
    }
  });

  it('memory_code rejects unknown mode', () => {
    const t = toolByName.memory_code;
    const out = t.toCommand({ mode: 'bogus', repo: 'r' }, { project: 'p' });
    expect(out.cmd).toBeNull();
    expect(out.error).toMatch(/Unknown memory_code mode/);
  });

  it('memory_save injects project + defaults from ctx', () => {
    const t = toolByName.memory_save;
    const out = t.toCommand({ title: 'T', content: 'C' }, { project: 'myproj' });
    expect(out.cmd).toBe('save');
    expect(out.args.project).toBe('myproj');
    expect(out.args.type).toBe('manual'); // Default
    expect(out.args.scope).toBe('project'); // Default
  });

  it('memory_save forwards optional kebab-case flags', () => {
    const t = toolByName.memory_save;
    const out = t.toCommand(
      { title: 'T', content: 'C', topic_key: 'auth', force: true, expires_in: '7d' },
      { project: 'p' },
    );
    expect(out.args['topic-key']).toBe('auth');
    expect(out.args.force).toBe('true');
    expect(out.args['expires-in']).toBe('7d');
  });

  it('memory_code callers/callees map to call-hierarchy with direction', () => {
    const t = toolByName.memory_code;
    expect(t.toCommand({ mode: 'callers', repo: 'r', symbol: 's' }, { project: 'p' }).args.direction).toBe('callers');
    expect(t.toCommand({ mode: 'callees', repo: 'r', symbol: 's' }, { project: 'p' }).args.direction).toBe('callees');
  });

  it('memory_code search uses max-results instead of top', () => {
    const t = toolByName.memory_code;
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
  it('lists all tools and calls memory_save → dispatch → result', async () => {
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
    expect(toolNames).toContain('memory_save');
    expect(toolNames).toContain('memory_search');
    expect(toolsList.tools.find((t) => t.name === 'memory_save').inputSchema.type).toBe('object');

    // Tools/call — save
    const saveResult = await client.callTool({
      name: 'memory_save',
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
    const searchResult = await client.callTool({ name: 'memory_search', arguments: { query: 'decisions' } });
    const searchParsed = JSON.parse(searchResult.content[0].text);
    expect(searchParsed.results[0].id).toBe(42);

    // Unknown tool → error
    const unknownResult = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(unknownResult.isError).toBe(true);
    expect(unknownResult.content[0].text).toMatch(/Unknown tool/);

    // Unknown memory_code mode → error
    const badMode = await client.callTool({ name: 'memory_code', arguments: { mode: 'not-a-mode' } });
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

    const result = await client.callTool({ name: 'memory_search', arguments: { query: 'x' } });
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
});

// --- helper ---

function sampleParams(name) {
  switch (name) {
    case 'memory_save':
      return { title: 'T', content: 'C' };
    case 'memory_search':
      return { query: 'q' };
    case 'memory_get':
    case 'memory_delete':
    case 'memory_related':
      return { id: 1 };
    case 'memory_update':
      return { id: 1, title: 'T' };
    case 'memory_load_context':
      return { query: 'q' };
    case 'memory_code':
      return { mode: 'outline', repo: 'r', file: 'src/foo.ts' };
    case 'memory_doc':
      return { mode: 'search', repo: 'r', query: 'q' };
    case 'memory_sync_code_trust':
      return { repo: 'r' };
    case 'index_status':
      return { job: 'j1' };
    default:
      return {};
  }
}
