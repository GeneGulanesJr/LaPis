// vitest globals enabled — no import; `vi` is a global
// Wire tests via injected fetchImpl — NO network, ungated.
const { createDecisionAdapter } = require('../src/judgment/adapters/decision');

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
  return createDecisionAdapter({
    apiKey: 'k-test',
    endpoint: 'https://fake.local/v1/systemone',
    fetchImpl,
    ...overrides,
  });
}

describe('decision adapter — request side', () => {
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
        model: 'd1-ultra',
        usage: {},
      });
    });
    const a = makeAdapter(fetchImpl);
    const r = await a.judge([probQ, clsQ, gradeQ]);
    expect(r.status).toBe('ok');
    expect(captured.opts.headers.Authorization).toBe('Bearer k-test');
    expect(captured.body.model).toBe('d1-ultra');
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

describe('decision adapter — defaults', () => {
  it('targets the Liquid Decisions API with d1-ultra unless overridden', async () => {
    const saved = { e: process.env.LAPIS_JUDGE_ENDPOINT, m: process.env.LAPIS_JUDGE_MODEL };
    delete process.env.LAPIS_JUDGE_ENDPOINT;
    delete process.env.LAPIS_JUDGE_MODEL;
    try {
      const p = await createDecisionAdapter({ apiKey: 'k-test' }).probe();
      expect(p).toEqual({
        ok: true,
        mode: 'ready',
        endpoint: 'https://api.liquid.ai/decisions/v1/systemone',
        model: 'd1-ultra',
      });
      expect((await createDecisionAdapter({ apiKey: 'k-test', model: 'd1' }).probe()).model).toBe('d1');
    } finally {
      if (saved.e !== undefined) process.env.LAPIS_JUDGE_ENDPOINT = saved.e;
      if (saved.m !== undefined) process.env.LAPIS_JUDGE_MODEL = saved.m;
    }
  });
});

describe('decision adapter — one-option choice (Liquid 422s on a choice with < 2 options)', () => {
  const oneQ = {
    id: 'only',
    judgment: { kind: 'classify', enum: ['keep'] },
    instructions: 'classify it',
    state: { msg: 'y' },
  };
  it('answers a one-option classify locally and does not send it', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return jsonResponse({ answers: { sup: { type: 'noul', noul: 0.9 } }, model: 'd1-ultra', usage: {} });
    });
    const r = await makeAdapter(fetchImpl).judge([oneQ, probQ]);
    expect(r.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Object.keys(captured.questions)).toEqual(['sup']);
    // state comes only from the questions actually sent
    expect(captured.state).toEqual({ a: 'old', b: 'new' });
    // answers keep the caller's question order
    expect(r.answers).toEqual([
      { id: 'only', pick: 'keep', confidence: 1 },
      { id: 'sup', p: 0.9, confidence: expect.closeTo(0.8, 5) },
    ]);
  });
  it('makes no request when every question is a one-option classify', async () => {
    const fetchImpl = vi.fn();
    const r = await makeAdapter(fetchImpl).judge([
      oneQ,
      { ...oneQ, id: 'only2', judgment: { kind: 'classify', enum: ['x'] } },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({
      status: 'ok',
      answers: [
        { id: 'only', pick: 'keep', confidence: 1 },
        { id: 'only2', pick: 'x', confidence: 1 },
      ],
    });
  });
});

describe('decision adapter — response side', () => {
  it('maps and normalizes the reply to typed answers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        answers: {
          sup: { noul: 0.2, confidence: 0.8 },
          type: { choice: 'decision', confidence: 0.9 },
          rel: { score: 2, confidence: 0.7 },
        },
        model: 'd1-ultra',
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
  it('live shape (Liquid d1-ultra): noul reply WITHOUT confidence → derived confidence |p−0.5|×2', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ answers: { sup: { type: 'noul', noul: 0.76 } }, model: 'd1-ultra', usage: {} }),
    );
    const r = await makeAdapter(fetchImpl).judge([probQ]);
    expect(r.status).toBe('ok');
    expect(r.answers[0].p).toBe(0.76);
    expect(r.answers[0].confidence).toBeCloseTo(0.52); // |0.76−0.5|×2
  });
  it('live shape (Liquid d1-ultra): FLOAT score (1.82) + legend → rounds to nearest level index', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        answers: {
          rel: {
            type: 'score',
            score: 1.82,
            confidence: 0.73,
            legend: { 0: 'irrelevant', 1: 'related', 2: 'central' },
            probabilities: { 0: 0.08, 1: 0.03, 2: 0.89 },
          },
        },
        model: 'd1-ultra',
        usage: {},
      }),
    );
    const r = await makeAdapter(fetchImpl).judge([gradeQ]);
    expect(r.status).toBe('ok');
    expect(r.answers[0]).toEqual({ id: 'rel', level: 2, confidence: 0.73 });
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
    const a = createDecisionAdapter({ apiKey: null, endpoint: 'https://fake.local', fetchImpl });
    const r = await a.judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/LIQUID_API_KEY/);
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
