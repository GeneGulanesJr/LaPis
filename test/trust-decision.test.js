// vitest globals enabled — no import
const { trustJevEnabled, jevInvalidationReview, maybeTrustJevReview } = require('../src/trust-sync/trust-jev');

function makeJudge(answers, meta = {}) {
  return vi.fn(async () => ({ status: meta.status || 'ok', answers, reason: meta.reason }));
}

// Decay candidates as they come out of evaluateTrustSync().adjusted
const decayLinks = [
  { memory_id: 12, symbol_id: 'evaluateTrustSync', old_trust: 1.0, new_trust: 0.3 },
  { memory_id: 13, symbol_id: 'syncCodeTrust', old_trust: 0.8, new_trust: 0.1 },
];

describe('jevInvalidationReview — advisory only, never writes', () => {
  it('empty links → {verified: []}, no judge constructed', async () => {
    const judge = makeJudge([]);
    const r = await jevInvalidationReview([], new Set(['x']), { _judge: judge });
    expect(r).toEqual({ verified: [] });
    expect(r.unavailable).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();
  });

  it('p=0.9/0.3 → invalidated true/false with fields copied; claim + surface correct', async () => {
    const judge = makeJudge([
      { id: 'trust-0', p: 0.9, confidence: 0.92 },
      { id: 'trust-1', p: 0.3, confidence: 0.71 },
    ]);
    const r = await jevInvalidationReview(decayLinks, ['evaluateTrustSync', 'syncCodeTrust'], { _judge: judge });
    expect(r.unavailable).toBeUndefined();
    expect(r.verified).toEqual([
      {
        memory_id: 12,
        symbol_id: 'evaluateTrustSync',
        p: 0.9,
        confidence: 0.92,
        invalidated: true,
      },
      { memory_id: 13, symbol_id: 'syncCodeTrust', p: 0.3, confidence: 0.71, invalidated: false },
    ]);
    // Claim contract + trust surface
    const [questions, opts] = judge.mock.calls[0];
    expect(questions[0].judgment.claim).toBe('Memory #12 is invalidated by changes to evaluateTrustSync');
    expect(questions[0].judgment.kind).toBe('probability');
    expect(questions[0].instructions).toMatch(/WRONG or misleading/);
    expect(opts).toEqual({ surface: 'trust' });
    expect(questions[0].state.memory).toEqual({ id: 12 }); // no deps → title omitted
    expect(questions[0].state.changed_symbols).toEqual(['evaluateTrustSync', 'syncCodeTrust']);
  });

  it('deps with sqlJson → title enriched into state.memory (best-effort)', async () => {
    const judge = makeJudge([{ id: 'trust-0', p: 0.9, confidence: 0.9 }]);
    const deps = { sqlJson: vi.fn(() => [{ id: 12, title: 'Trust policy decays on symbol change' }]) };
    await jevInvalidationReview([decayLinks[0]], ['evaluateTrustSync'], { _judge: judge, deps });
    expect(deps.sqlJson).toHaveBeenCalled();
    const questions = judge.mock.calls[0][0];
    expect(questions[0].state.memory).toEqual({ id: 12, title: 'Trust policy decays on symbol change' });
  });

  it('judge unavailable → {verified: [], unavailable: true}', async () => {
    const judge = makeJudge([], { status: 'unavailable', reason: 'provider off' });
    const r = await jevInvalidationReview(decayLinks, ['x'], { _judge: judge });
    expect(r.verified).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('judge that throws is contained → {verified: [], unavailable: true}, never throws', async () => {
    const judge = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await jevInvalidationReview(decayLinks, ['x'], { _judge: judge });
    expect(r.verified).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('batches questions at 10 per judge call (22 links → 3 calls)', async () => {
    const judge = makeJudge([]);
    const links = Array.from({ length: 22 }, (_, i) => ({
      memory_id: 100 + i,
      symbol_id: `sym${i}`,
      old_trust: 1,
      new_trust: 0.3,
    }));
    await jevInvalidationReview(links, ['sym0'], { _judge: judge });
    expect(judge).toHaveBeenCalledTimes(3); // 10 + 10 + 2
    expect(judge.mock.calls[0][0]).toHaveLength(10);
    expect(judge.mock.calls[1][0]).toHaveLength(10);
    expect(judge.mock.calls[2][0]).toHaveLength(2);
  });

  it('accepts Set changedSymbols and raw link shape with trust_score', async () => {
    const judge = makeJudge([{ id: 'trust-0', p: 0.8, confidence: 0.9 }]);
    const r = await jevInvalidationReview(
      [{ memory_id: 7, symbol_id: 'foo', trust_score: 0.5 }],
      new Set(['foo', 'bar', 'baz']),
      { _judge: judge },
    );
    expect(r.verified[0].invalidated).toBe(true);
    expect(judge.mock.calls[0][0][0].state.changed_symbols).toEqual(['foo', 'bar', 'baz']);
  });
});

describe('trustJevEnabled + maybeTrustJevReview — guard matrix', () => {
  const { resetConfigCache } = require('../config');
  const deps = { sqlJson: () => [] };
  let savedKey; // ambient TYPESAFE_API_KEY must not leak into guard results

  function withKey(value, fn) {
    savedKey = process.env.TYPESAFE_API_KEY;
    if (value === null) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = value;
    return fn();
  }
  function restoreKey() {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
    savedKey = undefined;
  }

  it('default config (heuristic, no key) → disabled', () => {
    withKey(null, () => {
      try {
        expect(trustJevEnabled()).toBe(false);
      } finally {
        restoreKey();
      }
    });
  });

  it('jev provider without key → disabled', () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    try {
      withKey(null, () => {
        resetConfigCache();
        expect(trustJevEnabled()).toBe(false);
      });
    } finally {
      restoreKey();
      delete process.env.LAPIS_JUDGE_PROVIDER;
      resetConfigCache();
    }
  });

  it('disabled trust surface → disabled even with jev + key', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'k-test';
    process.env.LAPIS_JUDGE_DISABLE_TRUST = '1';
    try {
      resetConfigCache();
      expect(trustJevEnabled()).toBe(false);
      await expect(maybeTrustJevReview(decayLinks, ['x'], deps, { _judge: makeJudge([]) })).resolves.toBeNull();
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.LAPIS_JUDGE_DISABLE_TRUST;
      resetConfigCache();
    }
  });

  it('jev + key → enabled; maybe wrapper passes through to the review (not null)', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'k-test';
    try {
      resetConfigCache();
      expect(trustJevEnabled()).toBe(true);
      const judge = makeJudge([
        { id: 'trust-0', p: 0.7, confidence: 0.8 },
        { id: 'trust-1', p: 0.2, confidence: 0.8 },
      ]);
      const r = await maybeTrustJevReview(decayLinks, ['x'], deps, { _judge: judge });
      expect(r).not.toBeNull();
      expect(r.unavailable).toBeUndefined();
      expect(r.verified).toHaveLength(2);
      expect(r.verified[0].invalidated).toBe(true);
      expect(r.verified[1].invalidated).toBe(false);
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.TYPESAFE_API_KEY;
      resetConfigCache();
    }
  });
});
