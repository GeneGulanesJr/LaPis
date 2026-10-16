// vitest globals enabled — no import
const { contextJevEnabled, jevSelectContext, maybeContextJevSelection } = require('../src/memory-domain/context-jev');
const { resetConfigCache } = require('../config');

// Real adapter shape for grade answers: {id, level: <index into levels>, confidence}
const LEVELS = ['filler', 'relevant', 'essential'];

function okJudge(levelByIndex) {
  return vi.fn(async (questions) => ({
    status: 'ok',
    answers: questions.map((q) => ({
      id: q.id,
      level: levelByIndex[Number(q.id.split('-')[1])],
      confidence: 0.9,
    })),
  }));
}

describe('jevSelectContext — budget-constrained selection', () => {
  it('empty candidates → {selected: [], dropped: []}, judge never built or called', async () => {
    const judge = vi.fn(),
      r = await jevSelectContext([], 'ship the parser fix', { _judge: judge });
    expect(r).toEqual({ selected: [], dropped: [] });
    expect(judge).not.toHaveBeenCalled();
  });

  it('essential/relevant/filler grades → level-desc selection in original order, budget cut stops the scan', async () => {
    const candidates = [
      { id: 1, title: 'parser decision', type: 'decision', content: 'x'.repeat(400), _tokens: 100 }, // essential
      { id: 2, title: 'parser pattern', type: 'pattern', content: 'y', _tokens: 200 }, // relevant
      { id: 3, title: 'unrelated chat', type: 'learning', content: 'z', _tokens: 50 }, // filler
      { id: 4, title: 'budget rationale', type: 'decision', content: 'w', _tokens: 3500 }, // essential, fits
      { id: 5, title: 'too big to fit', type: 'pattern', content: 'v', _tokens: 500 }, // relevant, cut
    ];
    // Level indices: essential=2, relevant=1, filler=0.
    const judge = okJudge({ 0: 2, 1: 1, 2: 0, 3: 2, 4: 1 });
    const r = await jevSelectContext(candidates, 'fix the tokenizer bug', { _judge: judge });

    expect(r.unavailable).toBeUndefined();
    // Greedy prefix at budget 4000 (default), level-desc (stable): essentials
    // c1(100) → c4(3600), then relevant c2(3800) → c5 would overflow (4300) →
    // scan stops; c3 is filler (never selected).
    expect(r.selected.map((c) => c.id)).toEqual([1, 2, 4]);
    expect(r.dropped.map((c) => c.id)).toEqual([3, 5]);

    // Question shape: grade judgment per candidate, task + capped snippet state.
    const [questions, opts] = judge.mock.calls[0];
    expect(opts).toEqual({ surface: 'context' });
    expect(questions).toHaveLength(5);
    expect(questions[0].judgment.kind).toBe('grade');
    expect(questions[0].judgment.levels).toEqual(['filler', 'relevant', 'essential']);
    expect(questions[0].state.task).toBe('fix the tokenizer bug');
    expect(questions[0].state.candidate.title).toBe('parser decision');
    expect(questions[0].state.candidate.content).toBe(`${'x'.repeat(300)}…`); // capText 300
    expect(questions[2].state.candidate.content).toBe('z');
  });

  it('all-filler → empty selection, everything dropped, no error', async () => {
    const candidates = [
      { id: 1, title: 'a', content: 'aaa', _tokens: 10 },
      { id: 2, title: 'b', content: 'bbb', _tokens: 10 },
      { id: 3, title: 'c', content: 'ccc', _tokens: 10 },
    ];
    const judge = okJudge({ 0: 0, 1: 0, 2: 0 });
    const r = await jevSelectContext(candidates, 'anything', { _judge: judge });
    expect(r).toEqual({ selected: [], dropped: candidates });
  });

  it('judgment unavailable → full candidate list as selected + unavailable flag', async () => {
    const judge = vi.fn(async () => ({ status: 'unavailable', reason: 'breaker open' })),
      candidates = [
        { id: 1, title: 'A', content: 'a' },
        { id: 2, title: 'B', content: 'b' },
      ],
      r = await jevSelectContext(candidates, 'task', { _judge: judge });
    expect(r.selected).toBe(candidates); // today's selection, same refs, same order
    expect(r.dropped).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('judge throws → same degradation (never throws past the call)', async () => {
    const judge = vi.fn(async () => {
        throw new Error('wire exploded');
      }),
      candidates = [
        { id: 1, title: 'A', content: 'a' },
        { id: 2, title: 'B', content: 'b' },
      ],
      r = await jevSelectContext(candidates, 'task', { _judge: judge });
    expect(r.selected).toBe(candidates);
    expect(r.dropped).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('batching: 30 candidates → 3 judge calls of 10, all essential → all selected in order', async () => {
    const judge = okJudge(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, 2]))),
      candidates = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `m${i}`, content: 'x'.repeat(10) })),
      r = await jevSelectContext(candidates, 'task', { _judge: judge });
    expect(judge).toHaveBeenCalledTimes(3);
    expect(judge.mock.calls[0][0]).toHaveLength(10);
    expect(judge.mock.calls[1][0]).toHaveLength(10);
    expect(judge.mock.calls[2][0]).toHaveLength(10);
    expect(r.unavailable).toBeUndefined();
    expect(r.selected.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
    expect(r.dropped).toEqual([]);
  });

  it('--token-budget (the real context budget field) caps the selection; no sizes → content length', async () => {
    const candidates = [
      { id: 1, title: 'small', content: 'x'.repeat(100) }, // essential
      { id: 2, title: 'big', content: 'y'.repeat(2000) }, // essential, would overflow
      { id: 3, title: 'small too', content: 'z'.repeat(50) }, // relevant
    ];
    const judge = okJudge({ 0: 2, 1: 2, 2: 1 });
    const r = await jevSelectContext(candidates, 'task', { _judge: judge, 'token-budget': 300 });
    // 100 → 2100 would overflow at #2 → scan stops; #3 never reached.
    expect(r.selected.map((c) => c.id)).toEqual([1]);
    expect(r.dropped.map((c) => c.id)).toEqual([2, 3]);
  });
});

describe('maybeContextJevSelection — guarded wrapper', () => {
  const SAVED = {},
    ENV_KEYS = ['LAPIS_JUDGE_PROVIDER', 'LAPIS_JUDGE_DISABLE_CONTEXT', 'TYPESAFE_API_KEY'];

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

  it('disabled → null (guard fires before the judge is ever built)', async () => {
    await withEnv({ LAPIS_JUDGE_PROVIDER: 'heuristic' }, async () => {
      const judge = vi.fn(),
        r = await maybeContextJevSelection([{ id: 1, title: 'A', content: 'a' }], 'task', null, { _judge: judge });
      expect(r).toBeNull();
      expect(judge).not.toHaveBeenCalled();
    });
  });

  it('enabled + injectable judge → selection result passes through', async () => {
    await withEnv({ LAPIS_JUDGE_PROVIDER: 'jev', TYPESAFE_API_KEY: 'k-test' }, async () => {
      const judge = okJudge({ 0: 2, 1: 0 }),
        candidates = [
          { id: 1, title: 'keep', content: 'a', _tokens: 10 },
          { id: 2, title: 'drop', content: 'b', _tokens: 10 },
        ],
        r = await maybeContextJevSelection(candidates, 'task', null, { _judge: judge });
      expect(r).toEqual({ selected: [candidates[0]], dropped: [candidates[1]] });
    });
  });
});

describe('contextJevEnabled — opt-in guard matrix', () => {
  const SAVED = {},
    ENV_KEYS = ['LAPIS_JUDGE_PROVIDER', 'LAPIS_JUDGE_DISABLE_CONTEXT', 'TYPESAFE_API_KEY'];

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
      expect(contextJevEnabled()).toBe(true);
    });
  });

  it('provider=heuristic → false even with key', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'heuristic', TYPESAFE_API_KEY: 'k-test' }, () => {
      expect(contextJevEnabled()).toBe(false);
    });
  });

  it('disables.context → false even with provider=jev + key', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'jev', LAPIS_JUDGE_DISABLE_CONTEXT: '1', TYPESAFE_API_KEY: 'k-test' }, () => {
      expect(contextJevEnabled()).toBe(false);
    });
  });

  it('missing TYPESAFE_API_KEY → false even with provider=jev', () => {
    withEnv({ LAPIS_JUDGE_PROVIDER: 'jev' }, () => {
      expect(contextJevEnabled()).toBe(false);
    });
  });
});
