// memory-save-classified — MCP catalog + decision-service HTTP client tests.
//
// vitest globals are enabled (vitest.config.mjs: globals: true), so no imports.
// We deliberately exercise:
//   1. MCP catalog presence + toCommand shape (parity with extensions/)
//   2. The HTTP client (decision.js) with a mocked fetch — the module owns
//      transport, timeouts, and JSON-RPC error envelopes.
//   3. autoClassify heuristics — pure logic, no fetch needed.

const decision = require('../src/memory-domain/decision'),
  { tools, toolByName } = require('../src/mcp/tools');

describe('memory-save-classified MCP catalog', () => {
  it('exposes memory-save-classified in the catalog', () => {
    const t = toolByName['memory-save-classified'];
    expect(t).toBeDefined();
    expect(t.name).toBe('memory-save-classified');
    expect(t.description).toMatch(/decision-service classification/);
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

describe('Decision service HTTP client', () => {
  let origFetch, origUrl, origEnabled, origTimeout, origPrefix;

  beforeEach(() => {
    origFetch = global.fetch;
    origUrl = process.env.LAPIS_DECISION_URL;
    origEnabled = process.env.LAPIS_DECISION_ENABLED;
    origTimeout = process.env.LAPIS_DECISION_TIMEOUT_MS;
    origPrefix = process.env.LAPIS_DECISION_TOOL_PREFIX;
    delete process.env.LAPIS_DECISION_URL;
    delete process.env.LAPIS_DECISION_ENABLED;
    delete process.env.LAPIS_DECISION_TIMEOUT_MS;
    delete process.env.LAPIS_DECISION_TOOL_PREFIX;
  });

  afterEach(() => {
    global.fetch = origFetch;
    const env = {
      LAPIS_DECISION_URL: origUrl,
      LAPIS_DECISION_ENABLED: origEnabled,
      LAPIS_DECISION_TIMEOUT_MS: origTimeout,
      LAPIS_DECISION_TOOL_PREFIX: origPrefix,
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('callDecision returns parsed result on success', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ is_injection: false, confidence: 0.9 }),
    }));
    const out = await decision.callDecision('laya_guard', { prompt: 'hi' });
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

  it('callDecision throws DecisionError on HTTP 500', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ error: 'kaboom' }),
    }));
    await expect(decision.callDecision('laya_guard', { prompt: 'hi' })).rejects.toMatchObject({
      name: 'DecisionError',
      status: 500,
      code: 'http_error',
    });
  });

  it('callDecision throws DecisionError on JSON-RPC error response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    }));
    await expect(decision.callDecision('laya_guard', { prompt: 'hi' })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'rpc_error',
    });
  });

  it('callDecision throws DecisionError when fetch aborts via AbortController timeout', async () => {
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
    await expect(decision.callDecision('laya_guard', { prompt: 'hi' }, { timeoutMs: 5 })).rejects.toMatchObject({
      name: 'DecisionError',
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
    const out = await decision.classify('hello', 'guard');
    expect(out.tool).toBe('laya_guard');
    expect(out.classification).toBe('guard');
    expect(out.confidence).toBe(0.75);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ tool: 'laya_guard', state: { prompt: 'hello' } });
  });

  it('tool names default to the reference service prefix but stay configurable', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ confidence: 0.5 }),
    }));

    // Default: the reference deployment's laya_* wire names.
    expect(decision.toolFor('guard')).toBe('laya_guard');

    // Any other backend: flip the prefix, no code change.
    process.env.LAPIS_DECISION_TOOL_PREFIX = 'zeus_';
    const out = await decision.classify('hello', 'triage');
    expect(out.tool).toBe('zeus_triage');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ tool: 'zeus_triage', state: { text: 'hello' } });
  });

  it('classify rejects unknown classification with bad_input code', async () => {
    await expect(decision.classify('x', 'banana')).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'bad_input',
      classification: 'banana',
    });
  });

  it('callDecision throws when disabled via env var', async () => {
    process.env.LAPIS_DECISION_ENABLED = 'false';
    global.fetch = vi.fn();
    await expect(decision.callDecision('laya_guard', { prompt: 'hi' })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'disabled',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('autoClassify heuristic', () => {
  it('detects email from header-like content', () => {
    expect(decision.autoClassify('From: alice@example.com\nSubject: hi\n\nbody')).toEqual({
      classification: 'email',
      reason: 'header-like content',
    });
  });

  it('detects triage from Ticket # / Status: / Priority: markers', () => {
    expect(decision.autoClassify('Ticket #1234 is broken')).toMatchObject({ classification: 'triage' });
    expect(decision.autoClassify('Status: open\nblah')).toMatchObject({ classification: 'triage' });
    expect(decision.autoClassify('Priority: high\nblah')).toMatchObject({ classification: 'triage' });
  });

  it('detects guard for short single-paragraph content', () => {
    expect(decision.autoClassify('Save this as a quick note for me.')).toMatchObject({ classification: 'guard' });
  });

  it('detects moderate for longer multi-paragraph payloads', () => {
    const long = 'Para one with some text.\n\nPara two also has content.\n\nPara three continues.';
    expect(decision.autoClassify(long)).toMatchObject({ classification: 'moderate' });
  });

  it('returns null for empty / whitespace-only content', () => {
    expect(decision.autoClassify('')).toBeNull();
    expect(decision.autoClassify('   \n\n  ')).toBeNull();
  });

  it('returns null for non-string content', () => {
    expect(decision.autoClassify(null)).toBeNull();
    expect(decision.autoClassify(undefined)).toBeNull();
    expect(decision.autoClassify(42)).toBeNull();
  });
});
