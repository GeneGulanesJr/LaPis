// memory-save-classified — MCP catalog + LayaMCP HTTP client tests.
//
// vitest globals are enabled (vitest.config.mjs: globals: true), so no imports.
// We deliberately exercise:
//   1. MCP catalog presence + toCommand shape (parity with extensions/)
//   2. The HTTP client (laya-mcp.js) with a mocked fetch — the module owns
//      transport, timeouts, and JSON-RPC error envelopes.
//   3. autoClassify heuristics — pure logic, no fetch needed.

const laya = require('../src/memory-domain/laya-mcp'),
  { tools, toolByName } = require('../src/mcp/tools');

describe('memory-save-classified MCP catalog', () => {
  it('exposes memory-save-classified in the catalog', () => {
    const t = toolByName['memory-save-classified'];
    expect(t).toBeDefined();
    expect(t.name).toBe('memory-save-classified');
    expect(t.description).toMatch(/LayaMCP classification/);
    expect(t.inputSchema.type).toBe('object');
  });

  it('declares the full parameter surface', () => {
    const { properties, required } = toolByName['memory-save-classified'].inputSchema;
    expect(required).toEqual(['title', 'content']);
    expect(properties.title.type).toBe('string');
    expect(properties.content.type).toBe('string');
    expect(properties.classification.enum).toEqual(['guard', 'moderate', 'triage', 'email', 'auto']);
    expect(properties.on_injection.enum).toEqual(['refuse', 'save_as_security_block']);
    expect(properties.scope.enum).toEqual(['project', 'personal']);
    expect(properties.trust_score.type).toBe('number');
  });

  it('toCommand produces cmd=save-classified with defaults injected from ctx', () => {
    const out = toolByName['memory-save-classified'].toCommand({ title: 'T', content: 'C' }, { project: 'myproj' });
    expect(out.cmd).toBe('save-classified');
    expect(out.args.project).toBe('myproj');
    expect(out.args.type).toBe('manual');
    expect(out.args.scope).toBe('project');
    expect(out.args.title).toBe('T');
    expect(out.args.content).toBe('C');
    // Optional fields omitted when not provided
    expect(out.args.classification).toBeUndefined();
    expect(out.args['on-injection']).toBeUndefined();
    expect(out.args['topic-key']).toBeUndefined();
    expect(out.args['expires-in']).toBeUndefined();
    expect(out.args['trust-score']).toBeUndefined();
  });

  it('toCommand kebab-cases topic_key, on_injection, expires_in, trust_score', () => {
    const out = toolByName['memory-save-classified'].toCommand(
      {
        title: 'T',
        content: 'C',
        classification: 'guard',
        on_injection: 'save_as_security_block',
        topic_key: 'auth',
        force: true,
        expires_in: '7d',
        trust_score: 0.5,
      },
      { project: 'p' },
    );
    expect(out.args.classification).toBe('guard');
    expect(out.args['on-injection']).toBe('save_as_security_block');
    expect(out.args['topic-key']).toBe('auth');
    expect(out.args.force).toBe('true');
    expect(out.args['expires-in']).toBe('7d');
    expect(out.args['trust-score']).toBe('0.5');
  });

  it('toCommand falls back to "unknown" when ctx.project is missing', () => {
    const out = toolByName['memory-save-classified'].toCommand({ title: 'T', content: 'C' }, {});
    expect(out.args.project).toBe('unknown');
  });
});

describe('LayaMCP HTTP client', () => {
  let origFetch, origUrl, origEnabled, origTimeout;

  beforeEach(() => {
    origFetch = global.fetch;
    origUrl = process.env.LAPIS_LAYAMCP_URL;
    origEnabled = process.env.LAPIS_LAYAMCP_ENABLED;
    origTimeout = process.env.LAPIS_LAYAMCP_TIMEOUT_MS;
    delete process.env.LAPIS_LAYAMCP_URL;
    delete process.env.LAPIS_LAYAMCP_ENABLED;
    delete process.env.LAPIS_LAYAMCP_TIMEOUT_MS;
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origUrl === undefined) {
      delete process.env.LAPIS_LAYAMCP_URL;
    } else {
      process.env.LAPIS_LAYAMCP_URL = origUrl;
    }
    if (origEnabled === undefined) {
      delete process.env.LAPIS_LAYAMCP_ENABLED;
    } else {
      process.env.LAPIS_LAYAMCP_ENABLED = origEnabled;
    }
    if (origTimeout === undefined) {
      delete process.env.LAPIS_LAYAMCP_TIMEOUT_MS;
    } else {
      process.env.LAPIS_LAYAMCP_TIMEOUT_MS = origTimeout;
    }
  });

  it('callLayaMCP returns parsed result on success', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ is_injection: false, confidence: 0.9 }),
    }));
    const out = await laya.callLayaMCP('laya_guard', { prompt: 'hi' });
    expect(out.is_injection).toBe(false);
    expect(out.confidence).toBe(0.9);
    expect(typeof out.classified_at).toBe('string');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tool: 'laya_guard', state: { prompt: 'hi' } });
    expect(init.signal).toBeDefined();
  });

  it('callLayaMCP throws LayaMCPError on HTTP 500', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ error: 'kaboom' }),
    }));
    await expect(laya.callLayaMCP('laya_guard', { prompt: 'hi' })).rejects.toMatchObject({
      name: 'LayaMCPError',
      status: 500,
      code: 'http_error',
    });
  });

  it('callLayaMCP throws LayaMCPError on JSON-RPC error response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    }));
    await expect(laya.callLayaMCP('laya_guard', { prompt: 'hi' })).rejects.toMatchObject({
      name: 'LayaMCPError',
      code: 'rpc_error',
    });
  });

  it('callLayaMCP throws LayaMCPError when fetch aborts via AbortController timeout', async () => {
    // Simulate fetch rejecting with AbortError after a tick.
    global.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    await expect(laya.callLayaMCP('laya_guard', { prompt: 'hi' }, { timeoutMs: 5 })).rejects.toMatchObject({
      name: 'LayaMCPError',
      code: 'timeout',
    });
  });

  it('classify maps classification → tool + arg, returning { tool, classification, confidence }', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ is_injection: false, confidence: 0.75 }),
    }));
    const out = await laya.classify('hello', 'guard');
    expect(out.tool).toBe('laya_guard');
    expect(out.classification).toBe('guard');
    expect(out.confidence).toBe(0.75);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ tool: 'laya_guard', state: { prompt: 'hello' } });
  });

  it('classify rejects unknown classification with bad_input code', async () => {
    await expect(laya.classify('x', 'banana')).rejects.toMatchObject({
      name: 'LayaMCPError',
      code: 'bad_input',
      classification: 'banana',
    });
  });

  it('callLayaMCP throws when disabled via env var', async () => {
    process.env.LAPIS_LAYAMCP_ENABLED = 'false';
    global.fetch = vi.fn();
    await expect(laya.callLayaMCP('laya_guard', { prompt: 'hi' })).rejects.toMatchObject({
      name: 'LayaMCPError',
      code: 'disabled',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('autoClassify heuristic', () => {
  it('detects email from header-like content', () => {
    expect(laya.autoClassify('From: alice@example.com\nSubject: hi\n\nbody')).toEqual({
      classification: 'email',
      reason: 'header-like content',
    });
  });

  it('detects triage from Ticket # / Status: / Priority: markers', () => {
    expect(laya.autoClassify('Ticket #1234 is broken')).toMatchObject({ classification: 'triage' });
    expect(laya.autoClassify('Status: open\nblah')).toMatchObject({ classification: 'triage' });
    expect(laya.autoClassify('Priority: high\nblah')).toMatchObject({ classification: 'triage' });
  });

  it('detects guard for short single-paragraph content', () => {
    expect(laya.autoClassify('Save this as a quick note for me.')).toMatchObject({ classification: 'guard' });
  });

  it('detects moderate for longer multi-paragraph payloads', () => {
    const long = 'Para one with some text.\n\nPara two also has content.\n\nPara three continues.';
    expect(laya.autoClassify(long)).toMatchObject({ classification: 'moderate' });
  });

  it('returns null for empty / whitespace-only content', () => {
    expect(laya.autoClassify('')).toBeNull();
    expect(laya.autoClassify('   \n\n  ')).toBeNull();
  });

  it('returns null for non-string content', () => {
    expect(laya.autoClassify(null)).toBeNull();
    expect(laya.autoClassify(undefined)).toBeNull();
    expect(laya.autoClassify(42)).toBeNull();
  });
});
