// vitest globals enabled — no import; `vi` is a global
// Wire tests via injected fetchImpl — NO network, ungated.
const { createJevAdapter } = require('../src/judgment/adapters/jev');

const probQ = {
  id: 'sup',
  judgment: { kind: 'probability', claim: 'A superseded by B' },
  instructions: 'Judge supersession.',
  state: { a: 'old', b: 'new' },
};
const clsQ = {
  id: 'type',
  judgment: { kind: 'classify', enum: ['decision', 'nothing'], dangerous: 'decision' },
  instructions: 'classify it',
  state: { msg: 'x' },
};
const gradeQ = {
  id: 'rel',
  judgment: { kind: 'grade', levels: ['irrelevant', 'related', 'central'] },
  instructions: 'rate relevance',
  state: { q: 'query' },
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeAdapter(fetchImpl, overrides = {}) {
  return createJevAdapter({ apiKey: 'k-test', endpoint: 'https://fake.local/v1/systemone', fetchImpl, ...overrides });
}

describe('jev adapter — request side', () => {
  it('translates LaPis judgments to the wire (probability→noul, classify→choice, grade→score)', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = { url, opts, body: JSON.parse(opts.body) };
      return jsonResponse({
        answers: {
          sup: { noul: 0.2, confidence: 0.8 },
          type: { choice: 'decision', confidence: 0.9 },
          rel: { score: 1, confidence: 0.7 },
        },
        model: 'jev',
        usage: {},
      });
    });
    const a = makeAdapter(fetchImpl);
    const r = await a.judge([probQ, clsQ, gradeQ]);
    expect(r.status).toBe('ok');
    expect(captured.opts.headers.Authorization).toBe('Bearer k-test');
    expect(captured.body.model).toBe('jev-latest');
    // claim is folded into instructions so the wire question is self-contained
    expect(captured.body.questions.sup).toEqual({
      type: 'noul',
      instructions: 'Judge supersession. Claim: A superseded by B',
    });
    // polarity is NOT annotated into criteria — dangerous-marking lives in evaluate.js only
    expect(captured.body.questions.type.criteria).toEqual({ decision: 'decision', nothing: 'nothing' });
    expect(captured.body.questions.rel.criteria).toEqual(['irrelevant', 'related', 'central']);
    // per-request `state` is the merge of every question's state (later wins)
    expect(captured.body.state).toEqual({ a: 'old', b: 'new', msg: 'x', q: 'query' });
  });
});

describe('jev adapter — response side', () => {
  it('maps and normalizes the reply to typed answers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        answers: {
          sup: { noul: 0.2, confidence: 0.8 },
          type: { choice: 'decision', confidence: 0.9 },
          rel: { score: 2, confidence: 0.7 },
        },
        model: 'jev',
        usage: {},
      }),
    );
    const r = await makeAdapter(fetchImpl).judge([probQ, clsQ, gradeQ]);
    expect(r.status).toBe('ok');
    expect(r.answers).toEqual([
      { id: 'sup', p: 0.2, confidence: 0.8 },
      { id: 'type', pick: 'decision', confidence: 0.9 },
      { id: 'rel', level: 2, confidence: 0.7 },
    ]);
  });
  it('non-2xx → unavailable (never throws)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'boom', json: async () => ({}) }));
    const r = await makeAdapter(fetchImpl).judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/HTTP 503/);
  });
  it('malformed-OK 200 → invalid, not crash (RetellMCP P1 #3)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ answers: { sup: { confidence: 0.9 } } })); // missing noul
    const r = await makeAdapter(fetchImpl).judge([probQ]);
    expect(r.status).toBe('invalid');
    expect(r.reason).toMatch(/sup/);
  });
  it('missing key → unavailable before any fetch (P1 #2)', async () => {
    const fetchImpl = vi.fn();
    const a = createJevAdapter({ apiKey: null, endpoint: 'https://fake.local', fetchImpl });
    const r = await a.judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/TYPESAFE_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('network throw → unavailable after retries', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await makeAdapter(fetchImpl, { maxRetries: 1 }).judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 + maxRetries
  });
  it('bad question (invalid enum ref) → invalid without fetching', async () => {
    const fetchImpl = vi.fn();
    const a = makeAdapter(fetchImpl);
    const r = await a.judge([{ ...clsQ, judgment: { kind: 'classify', enum: [] } }]);
    expect(r.status).toBe('invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
