// vitest globals enabled — no import
const { jevVerifyDuplicates, dedupeJevEnabled } = require('../src/memory-domain/dedupe-jev');
const { resetConfigCache } = require('../config');

describe('jevVerifyDuplicates — read-only, advisory', () => {
  it('empty candidates → {verified: []}, judge never built or called', async () => {
    const judge = vi.fn(),
      r = await jevVerifyDuplicates({}, [], { _judge: judge });
    expect(r).toEqual({ verified: [] });
    expect(judge).not.toHaveBeenCalled();
  });

  it('fake judge p=0.9/0.2 → same true/false with p + confidence copied', async () => {
    const judge = vi.fn(async () => ({
        status: 'ok',
        answers: [
          { id: 'dup-0', p: 0.9, confidence: 0.88 },
          { id: 'dup-1', p: 0.2, confidence: 0.75 },
        ],
      })),
      candidates = [
        { id: 5, title: 'Auth flow v1', content: 'session cookie flow' },
        { id: 6, title: 'Deploy docs' },
      ],
      r = await jevVerifyDuplicates({}, candidates, {
        _judge: judge,
        incomingTitle: 'Auth flow v2',
        incomingContent: 'v2 replaces v1',
      });
    expect(r.unavailable).toBeUndefined();
    expect(r.verified).toHaveLength(2);
    expect(r.verified[0]).toEqual({ id: 5, title: 'Auth flow v1', p: 0.9, confidence: 0.88, same: true });
    expect(r.verified[1]).toEqual({ id: 6, title: 'Deploy docs', p: 0.2, confidence: 0.75, same: false });

    // Question shape: probability judgment per candidate, incoming state carried.
    const [questions, opts] = judge.mock.calls[0];
    expect(opts).toEqual({ surface: 'dedupe' });
    expect(questions).toHaveLength(2);
    expect(questions[0].judgment.kind).toBe('probability');
    expect(questions[0].judgment.claim).toContain('memory #5');
    expect(questions[0].state.existing.id).toBe(5);
    expect(questions[0].state.incoming.title).toBe('Auth flow v2');
    expect(questions[1].state.existing.content).toBe(''); // missing content → capped empty
  });

  it('judgment unavailable → {verified: [], unavailable: true}', async () => {
    const judge = vi.fn(async () => ({ status: 'unavailable', reason: 'breaker open' })),
      r = await jevVerifyDuplicates({}, [{ id: 1, title: 'A' }], { _judge: judge });
    expect(r.verified).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('judge throws → {verified: [], unavailable: true} (never throws past the call)', async () => {
    const judge = vi.fn(async () => {
        throw new Error('wire exploded');
      }),
      r = await jevVerifyDuplicates(
        {},
        [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
        ],
        { _judge: judge },
      );
    expect(r.verified).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('batching: 15 candidates → 2 judge calls, all verified in order', async () => {
    const judge = vi.fn(async (questions) => ({
        status: 'ok',
        answers: questions.map((q) => ({ id: q.id, p: 0.6, confidence: 0.5 })),
      })),
      candidates = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `m${i}` })),
      r = await jevVerifyDuplicates({}, candidates, { _judge: judge });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judge.mock.calls[0][0]).toHaveLength(10);
    expect(judge.mock.calls[1][0]).toHaveLength(5);
    expect(r.verified).toHaveLength(15);
    expect(r.verified.map((v) => v.id)).toEqual(candidates.map((c) => c.id));
  });
});

describe('dedupeJevEnabled — opt-in guard matrix', () => {
  const SAVED = {},
    ENV_KEYS = ['LAPIS_JUDGE_PROVIDER', 'LAPIS_JUDGE_DISABLE_DEDUPE', 'TYPESAFE_API_KEY'];

  function withEnv(env, fn) {
    for (const k of ENV_KEYS) {
      SAVED[k] = process.env[k];
      if (env[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = env[k];
      }
    }
    resetConfigCache();
    try {
      return fn();
    } finally {
      for (const k of ENV_KEYS) {
        if (SAVED[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = SAVED[k];
        }
      }
      resetConfigCache();
    }
  }

  it('provider=jev + TYPESAFE_API_KEY → true', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'jev', TYPESAFE_API_KEY: 'k-test' }, () => {
      expect(dedupeJevEnabled()).toBe(true);
    });
  });

  it('provider=heuristic → false even with key', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'heuristic', TYPESAFE_API_KEY: 'k-test' }, () => {
      expect(dedupeJevEnabled()).toBe(false);
    });
  });

  it('disables.dedupe → false even with provider=jev + key', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'jev', LAPIS_JUDGE_DISABLE_DEDUPE: '1', TYPESAFE_API_KEY: 'k-test' }, () => {
      expect(dedupeJevEnabled()).toBe(false);
    });
  });

  it('missing TYPESAFE_API_KEY → false even with provider=jev', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'jev' }, () => {
      expect(dedupeJevEnabled()).toBe(false);
    });
  });
});
