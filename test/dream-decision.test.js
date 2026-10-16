// vitest globals enabled — no import
const { dreamDecisionReview } = require('../src/memory-domain/dream-decision');

function makeJudge(answers, meta = {}) {
  return vi.fn(async () => ({ status: meta.status || 'ok', answers, reason: meta.reason }));
}

const fakeDeps = {
  sqlJson: vi.fn((sql) => {
    if (/observation_relations/.test(sql)) {
      return [
        {
          id: 12,
          title: 'Auth flow v1',
          type: 'decision',
          project: 'x',
          newer_id: 48,
          relation: 'supersedes',
          confidence: 0.9,
          newer_title: 'Auth flow v2',
          content: 'v1 session cookie flow',
          newer_content: 'v2 replaces v1 with CSRF hardening',
        },
        {
          id: 13,
          title: 'Old deploy docs',
          type: 'manual',
          project: 'x',
          newer_id: 50,
          relation: 'duplicate',
          confidence: 0.95,
          newer_title: 'Deploy docs',
          content: 'old docs',
          newer_content: 'new docs',
        },
      ];
    }
    return [{ id: 77, title: 'CORRECTION: fix port', content: 'supersedes #12 — port is 3002', project: 'x' }];
  }),
  sqlRun: vi.fn(),
  softDeleteObservation: vi.fn(),
};

describe('dreamDecisionReview — advisory only', () => {
  it('never deletes anything, even when every verdict says superseded', async () => {
    const judge = makeJudge([
      { id: 'sup-0', p: 0.95, confidence: 0.9 },
      { id: 'sup-1', p: 0.95, confidence: 0.9 },
      { id: 'cor-0', p: 0.9, confidence: 0.9 },
    ]);
    const r = await dreamDecisionReview(fakeDeps, { _judge: judge });
    expect(fakeDeps.softDeleteObservation).not.toHaveBeenCalled();
    expect(fakeDeps.sqlRun).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.superseded.verified).toHaveLength(2);
    expect(r.corrections.verified).toHaveLength(1);
  });
  it('flags low-p candidates as keep with reasons', async () => {
    const judge = makeJudge([
      { id: 'sup-0', p: 0.2, confidence: 0.85 },
      { id: 'sup-1', p: 0.9, confidence: 0.9 },
      { id: 'cor-0', p: 0.1, confidence: 0.8 },
    ]);
    const r = await dreamDecisionReview(fakeDeps, { _judge: judge });
    expect(r.superseded.verified[0].verdict).toBe('keep');
    expect(r.superseded.verified[0].p).toBe(0.2);
    expect(r.superseded.verified[1].verdict).toBe('superseded');
    expect(r.corrections.verified[0].verdict).toBe('keep');
  });
  it('judgment unavailable → ok report with unavailable:true and empty verdicts', async () => {
    const judge = makeJudge([], { status: 'unavailable', reason: 'off' });
    const r = await dreamDecisionReview(fakeDeps, { _judge: judge });
    expect(r.ok).toBe(true);
    expect(r.unavailable).toBe(true);
    expect(r.superseded.verified).toEqual([]);
    expect(r.corrections.verified).toEqual([]);
  });
  it('no _judge and provider heuristic → unavailable report, zero adapter construction', async () => {
    // Env stubs (house pattern) pin the provider hermetically — machine
    // config may legitimately set provider=decision with a real key in env.
    const prevProvider = process.env.LAPIS_JUDGE_PROVIDER;
    const prevKey = process.env.LIQUID_API_KEY;
    process.env.LAPIS_JUDGE_PROVIDER = 'heuristic';
    delete process.env.LIQUID_API_KEY;
    require('../config').resetConfigCache();
    try {
      const r = await dreamDecisionReview(fakeDeps, {});
      expect(r.ok).toBe(true);
      expect(r.unavailable).toBe(true);
      expect(r.provider).toBe('heuristic');
    } finally {
      if (prevProvider === undefined) delete process.env.LAPIS_JUDGE_PROVIDER;
      else process.env.LAPIS_JUDGE_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = prevKey;
      require('../config').resetConfigCache();
    }
  });
  it('judge that throws is contained → ok/unavailable', async () => {
    const judge = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await dreamDecisionReview(fakeDeps, { _judge: judge });
    expect(r.ok).toBe(true);
    expect(r.unavailable).toBe(true);
  });
  it('batches questions at 10 per judge call', async () => {
    const bigDeps = {
      ...fakeDeps,
      sqlJson: vi.fn((sql) => {
        if (/observation_relations/.test(sql)) {
          return Array.from({ length: 25 }, (_, i) => ({
            id: i,
            title: `t${i}`,
            type: 'decision',
            project: 'x',
            newer_id: 1000 + i,
            relation: 'supersedes',
            confidence: 0.9,
            newer_title: `n${i}`,
            content: 'c',
            newer_content: 'nc',
          }));
        }
        return [];
      }),
    };
    const judge = makeJudge([]);
    await dreamDecisionReview(bigDeps, { _judge: judge });
    expect(judge).toHaveBeenCalledTimes(3); // 25 sup + 0 cor → chunks 10,10,5
  });
});

describe('maybeDreamDecisionReview — single guard for all dream callers', () => {
  const { maybeDreamDecisionReview } = require('../src/memory-domain/dream-decision');
  const deps = { sqlJson: () => [] };

  it('heuristic provider (env-stubbed) → null, dream pipeline untouched', async () => {
    const prevProvider = process.env.LAPIS_JUDGE_PROVIDER;
    const prevKey = process.env.LIQUID_API_KEY;
    process.env.LAPIS_JUDGE_PROVIDER = 'heuristic';
    delete process.env.LIQUID_API_KEY;
    require('../config').resetConfigCache();
    try {
      const r = await maybeDreamDecisionReview(deps, { _judge: makeJudge([]) });
      expect(r).toBeNull();
    } finally {
      if (prevProvider === undefined) delete process.env.LAPIS_JUDGE_PROVIDER;
      else process.env.LAPIS_JUDGE_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = prevKey;
      require('../config').resetConfigCache();
    }
  });

  it('disabled surface → null even with decision provider + key', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'decision';
    process.env.LAPIS_JUDGE_DISABLE_DREAM = '1';
    process.env.LIQUID_API_KEY = 'k-test';
    try {
      const { resetConfigCache } = require('../config');
      resetConfigCache();
      const r = await maybeDreamDecisionReview(deps, {});
      expect(r).toBeNull();
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.LAPIS_JUDGE_DISABLE_DREAM;
      delete process.env.LIQUID_API_KEY;
      require('../config').resetConfigCache();
    }
  });

  it('decision + key + args._judge → passes through to dreamDecisionReview (test injection)', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'decision';
    process.env.LIQUID_API_KEY = 'k-test';
    try {
      const { resetConfigCache } = require('../config');
      resetConfigCache();
      const judge = makeJudge([]);
      const r = await maybeDreamDecisionReview(deps, { _judge: judge });
      expect(r.ok).toBe(true);
      expect(r.unavailable).toBeUndefined(); // passthrough reached the review, not the null guard
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.LIQUID_API_KEY;
      require('../config').resetConfigCache();
    }
  });
});
