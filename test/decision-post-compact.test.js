import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runDecisionPostCompact, verdictLabel } from '../extensions/memory-layer/hooks/decision-post-compact.ts';

describe('runDecisionPostCompact', () => {
  beforeEach(() => {
    process.env.DECISION_DRY_RUN = '1';
  });

  it('returns an empty output when there is no project', async () => {
    const out = await runDecisionPostCompact({
      currentProject: '',
      sessionId: 1,
      pinnedPolicies: [],
      reInjectedTitles: [],
      lostTopics: [],
    });
    expect(out).toEqual({ messages: [] });
  });

  it('emits two messages (C + A) in dry-run mode', async () => {
    const out = await runDecisionPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: ['no hardcoded secrets'],
      reInjectedTitles: ['phase 5 schema fallback'],
      lostTopics: [],
    });
    expect(out.messages).toHaveLength(2);
    const cMessage = out.messages.find((m) => m.kind === 'reclassify');
    expect(cMessage).toBeDefined();
    expect(cMessage.choice).toMatch(/^(yes|partial|no)$/);
    expect(cMessage.confidence).toBeGreaterThanOrEqual(0);
  });

  it('emits a verdict message for A with a valid label', async () => {
    const out = await runDecisionPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: [],
      reInjectedTitles: ['bun chosen over npm'],
      lostTopics: ['decided to use bun instead of npm'],
    });
    const aMessage = out.messages.find((m) => m.kind === 'verdict');
    expect(aMessage).toBeDefined();
    expect(aMessage.score).toBeGreaterThanOrEqual(0);
    expect(aMessage.score).toBeLessThan(4);
    expect(aMessage.label).toMatch(/incomplete|partial|mostly-complete|complete/);
  });

  it('returns [] when DECISION_ENABLED unset AND not in dry-run', async () => {
    delete process.env.DECISION_DRY_RUN;
    delete process.env.DECISION_ENABLED;
    const out = await runDecisionPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: ['x'],
      reInjectedTitles: ['y'],
      lostTopics: [],
    });
    expect(out.messages).toEqual([]);
  });

  it('never throws — failures degrade to an empty output', async () => {
    // Force a non-dry-run with no API key set
    delete process.env.DECISION_DRY_RUN;
    delete process.env.LIQUID_API_KEY;
    process.env.DECISION_ENABLED = '1';

    const out = await runDecisionPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: ['x'],
      reInjectedTitles: ['y'],
      lostTopics: [],
    });
    // No key → liveAsk throws → we swallow and return []
    expect(out.messages).toEqual([]);
  });

  it('labels a float verdict score by rounding to the nearest level, clamped', () => {
    expect(verdictLabel(0)).toBe('incomplete');
    expect(verdictLabel(1.72)).toBe('mostly-complete');
    expect(verdictLabel(1.49)).toBe('partial');
    expect(verdictLabel(3.6)).toBe('complete');
    expect(verdictLabel(-0.4)).toBe('incomplete');
    expect(verdictLabel(Number.NaN)).toBe('unknown');
  });

  it('labels the live float score of the A question (was always "unknown")', async () => {
    const savedFetch = globalThis.fetch;
    const savedKey = process.env.LIQUID_API_KEY;
    delete process.env.DECISION_DRY_RUN;
    process.env.DECISION_ENABLED = '1';
    process.env.LIQUID_API_KEY = 'test-key';
    globalThis.fetch = vi.fn(async (_url, init) => {
      const q = JSON.parse(init.body).questions.q;
      const answer =
        q.type === 'choice'
          ? { type: 'choice', choice: 'yes', confidence: 0.9 }
          : { type: 'score', score: 1.72, confidence: 0.5 };
      return { ok: true, status: 200, json: async () => ({ answers: { q: answer } }) };
    });
    try {
      const out = await runDecisionPostCompact({
        currentProject: 'Documents',
        sessionId: 1,
        pinnedPolicies: ['x'],
        reInjectedTitles: ['y'],
        lostTopics: ['z'],
      });
      const verdict = out.messages.find((m) => m.kind === 'verdict');
      expect(verdict).toEqual({ kind: 'verdict', score: 1.72, label: 'mostly-complete' });
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) {
        delete process.env.LIQUID_API_KEY;
      } else {
        process.env.LIQUID_API_KEY = savedKey;
      }
      delete process.env.DECISION_ENABLED;
    }
  });
});
