// vitest globals enabled — no import
const { dreamJevReview } = require('../src/memory-domain/dream-jev');

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

describe('dreamJevReview — advisory only', () => {
  it('never deletes anything, even when every verdict says superseded', async () => {
    const judge = makeJudge([
      { id: 'sup-0', p: 0.95, confidence: 0.9 },
      { id: 'sup-1', p: 0.95, confidence: 0.9 },
      { id: 'cor-0', p: 0.9, confidence: 0.9 },
    ]);
    const r = await dreamJevReview(fakeDeps, { _judge: judge });
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
    const r = await dreamJevReview(fakeDeps, { _judge: judge });
    expect(r.superseded.verified[0].verdict).toBe('keep');
    expect(r.superseded.verified[0].p).toBe(0.2);
    expect(r.superseded.verified[1].verdict).toBe('superseded');
    expect(r.corrections.verified[0].verdict).toBe('keep');
  });
  it('judgment unavailable → ok report with unavailable:true and empty verdicts', async () => {
    const judge = makeJudge([], { status: 'unavailable', reason: 'off' });
    const r = await dreamJevReview(fakeDeps, { _judge: judge });
    expect(r.ok).toBe(true);
    expect(r.unavailable).toBe(true);
    expect(r.superseded.verified).toEqual([]);
    expect(r.corrections.verified).toEqual([]);
  });
  it('no _judge and default provider heuristic → unavailable report, zero adapter construction', async () => {
    const r = await dreamJevReview(fakeDeps, {});
    expect(r.ok).toBe(true);
    expect(r.unavailable).toBe(true);
    expect(r.provider).toBe('heuristic');
  });
  it('judge that throws is contained → ok/unavailable', async () => {
    const judge = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await dreamJevReview(fakeDeps, { _judge: judge });
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
    await dreamJevReview(bigDeps, { _judge: judge });
    expect(judge).toHaveBeenCalledTimes(3); // 25 sup + 0 cor → chunks 10,10,5
  });
});

describe('maybeDreamJevReview — single guard for all dream callers', () => {
  const { maybeDreamJevReview } = require('../src/memory-domain/dream-jev');
  const deps = { sqlJson: () => [] };

  it('default config (heuristic) → null, dream pipeline untouched', async () => {
    const r = await maybeDreamJevReview(deps, { _judge: makeJudge([]) });
    expect(r).toBeNull();
  });

  it('disabled surface → null even with jev provider + key', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    process.env.LAPIS_JUDGE_DISABLE_DREAM = '1';
    process.env.TYPESAFE_API_KEY = 'k-test';
    try {
      const { resetConfigCache } = require('../config');
      resetConfigCache();
      const r = await maybeDreamJevReview(deps, {});
      expect(r).toBeNull();
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.LAPIS_JUDGE_DISABLE_DREAM;
      delete process.env.TYPESAFE_API_KEY;
      require('../config').resetConfigCache();
    }
  });

  it('jev + key + args._judge → passes through to dreamJevReview (test injection)', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'k-test';
    try {
      const { resetConfigCache } = require('../config');
      resetConfigCache();
      const judge = makeJudge([]);
      const r = await maybeDreamJevReview(deps, { _judge: judge });
      expect(r.ok).toBe(true);
      expect(r.unavailable).toBeUndefined(); // passthrough reached the review, not the null guard
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.TYPESAFE_API_KEY;
      require('../config').resetConfigCache();
    }
  });
});
