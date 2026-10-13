// memory-save-classified — MCP catalog + DecisionMCP client tests.
//
// vitest globals are enabled (vitest.config.mjs: globals: true), so no imports.
// We deliberately exercise:
//   1. MCP catalog presence + toCommand shape (parity with extensions/)
//   2. The DecisionMCP client (decision.js) with an injected fake MCP SDK —
//      the module owns connect → tools/call → close, the overall deadline,
//      and result parsing (isError blocks, non-JSON content, confidence
//      default).  Injection via ctx.sdk, per the repo's injectable-seam
//      testing convention.
//   3. autoClassify heuristics — pure logic, no MCP needed.

const decision = require('../src/memory-domain/decision'),
  { toolByName } = require('../src/mcp/tools');

describe('memory-save-classified MCP catalog', () => {
  it('exposes memory-save-classified in the catalog', () => {
    const t = toolByName['memory-save-classified'];
    expect(t).toBeDefined();
    expect(t.name).toBe('memory-save-classified');
    expect(t.description).toMatch(/DecisionMCP classification/);
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

describe('DecisionMCP client', () => {
  let connectMock, callToolMock, closeMock, sdk, clientCount, transportHrefs, origUrl, origEnabled, origTimeout;

  beforeEach(() => {
    connectMock = vi.fn().mockResolvedValue(undefined);
    callToolMock = vi.fn();
    closeMock = vi.fn().mockResolvedValue(undefined);
    clientCount = 0;
    transportHrefs = [];
    // Plain constructor functions — vi.fn() arrow impls are not constructable.
    function FakeClient() {
      clientCount += 1;
      return { connect: connectMock, callTool: callToolMock, close: closeMock };
    }
    function FakeTransport(url) {
      transportHrefs.push(String(url.href));
      return {};
    }
    sdk = { Client: FakeClient, SSEClientTransport: FakeTransport };
    origUrl = process.env.LAPIS_DECISIONMCP_URL;
    origEnabled = process.env.LAPIS_DECISIONMCP_ENABLED;
    origTimeout = process.env.LAPIS_DECISIONMCP_TIMEOUT_MS;
    delete process.env.LAPIS_DECISIONMCP_URL;
    delete process.env.LAPIS_DECISIONMCP_ENABLED;
    delete process.env.LAPIS_DECISIONMCP_TIMEOUT_MS;
  });

  afterEach(() => {
    const env = {
      LAPIS_DECISIONMCP_URL: origUrl,
      LAPIS_DECISIONMCP_ENABLED: origEnabled,
      LAPIS_DECISIONMCP_TIMEOUT_MS: origTimeout,
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('classify connects to /sse, calls the decision_* tool, and parses the JSON content', async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ is_injection: false, confidence: 0.9 }) }],
    });
    const out = await decision.classify('hello', 'guard', { sdk });
    expect(out.tool).toBe('decision_guard');
    expect(out.classification).toBe('guard');
    expect(out.confidence).toBe(0.9);
    expect(out.result).toEqual({ is_injection: false, confidence: 0.9 });
    expect(typeof out.classified_at).toBe('string');
    expect(transportHrefs[0]).toBe('http://127.0.0.1:8765/sse');
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith({ name: 'decision_guard', arguments: { prompt: 'hello' } }, undefined, {
      timeout: expect.any(Number),
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('maps each classification to its DecisionMCP tool and argument key', async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ confidence: 0.5 }) }],
    });
    await decision.classify('body text', 'email', { sdk });
    expect(callToolMock.mock.calls[0][0]).toEqual({
      name: 'decision_email',
      arguments: { body: 'body text' },
    });
  });

  it('defaults confidence to 0.5 when the engine omits it', async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ is_injection: false }) }],
    });
    const out = await decision.classify('hello', 'guard', { sdk });
    expect(out.confidence).toBe(0.5);
  });

  it('throws DecisionError with tool_error when the tool replies isError', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'model exploded' }], isError: true });
    await expect(decision.classify('hello', 'guard', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'tool_error',
      classification: 'guard',
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws DecisionError with bad_response on non-JSON tool content', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }] });
    await expect(decision.classify('hello', 'guard', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'bad_response',
    });
  });

  it('throws DecisionError with network_error when the SSE connect fails', async () => {
    connectMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8765'));
    await expect(decision.classify('hello', 'guard', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'network_error',
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws DecisionError with timeout when the tool call exceeds the deadline', async () => {
    process.env.LAPIS_DECISIONMCP_TIMEOUT_MS = '5';
    callToolMock.mockImplementation(() => new Promise(() => {}));
    await expect(decision.classify('hello', 'guard', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'timeout',
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws DecisionError with disabled before constructing a client when disabled via env', async () => {
    process.env.LAPIS_DECISIONMCP_ENABLED = 'false';
    await expect(decision.classify('hello', 'guard', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'disabled',
    });
    expect(clientCount).toBe(0);
  });

  it('rejects unknown classification with bad_input before constructing a client', async () => {
    await expect(decision.classify('x', 'banana', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'bad_input',
      classification: 'banana',
    });
    expect(clientCount).toBe(0);
  });

  it('rejects empty content with bad_input', async () => {
    await expect(decision.classify('', 'guard', { sdk })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'bad_input',
    });
    expect(clientCount).toBe(0);
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
