import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decisionAsk, isDecisionDryRun } from '../extensions/memory-layer/host/decision-client.ts';

describe('decision-client', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DECISION_DRY_RUN;
    delete process.env.DECISION_TIMEOUT_MS;
    delete process.env.DECISION_MAX_RETRIES;
    delete process.env.JEV_DRY_RUN;
    delete process.env.JEV_TIMEOUT_MS;
    delete process.env.JEV_MAX_RETRIES;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('isDecisionDryRun', () => {
    it('returns true when DECISION_DRY_RUN=1', () => {
      process.env.DECISION_DRY_RUN = '1';
      expect(isDecisionDryRun()).toBe(true);
    });

    it('returns false when DECISION_DRY_RUN unset', () => {
      expect(isDecisionDryRun()).toBe(false);
    });
  });

  describe('decisionAsk dry-run', () => {
    beforeEach(() => {
      process.env.DECISION_DRY_RUN = '1';
    });

    it('returns a canned verdict for a "choice" question', async () => {
      const q = {
        kind: 'choice',
        question: 'Does the re-injected context cover pinned policies?',
        options: [
          { key: 'yes', description: 'all pinned policies are referenced or visible' },
          { key: 'partial', description: 'some references, gaps possible' },
          { key: 'no', description: 'no references to pinned policies' },
        ],
      };
      const result = await decisionAsk(q);
      expect(result).toMatchObject({
        choice: expect.stringMatching(/^(yes|partial|no)$/),
        confidence: expect.any(Number),
      });
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('returns a canned score for a "score" question', async () => {
      const q = {
        kind: 'score',
        question: 'How complete is the post-compact memory slice?',
        levels: ['incomplete', 'partial', 'mostly-complete', 'complete'],
      };
      const result = await decisionAsk(q);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThan(4);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('throws on unknown question kind', async () => {
      await expect(decisionAsk({ kind: 'unknown' })).rejects.toThrow(/unknown question kind/);
    });
  });

  describe('decisionAsk live (mocked fetch)', () => {
    beforeEach(() => {
      // Live mode requires a key to reach the fetch call; tests don't care about the value.
      process.env.LIQUID_API_KEY = 'test-key';
    });

    it('POSTs the /systemone wire shape { model, state, questions: { q } } and unwraps the response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          answers: { q: { type: 'choice', choice: 'yes', probabilities: { yes: 0.95, no: 0.05 }, confidence: 0.9 } },
        }),
      });
      globalThis.fetch = fetchMock;

      const q = {
        kind: 'choice',
        question: 'Are policies referenced?',
        options: [
          { key: 'yes', description: 'yes' },
          { key: 'no', description: 'no' },
        ],
      };
      const result = await decisionAsk(q);
      expect(result).toEqual({ choice: 'yes', confidence: 0.9 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.liquid.ai/decisions/v1/systemone');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer test-key');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        model: 'd1-ultra',
        state: {},
        questions: {
          q: { type: 'choice', instructions: 'Are policies referenced?', criteria: { yes: 'yes', no: 'no' } },
        },
      });
    });

    it('sends a score question with its levels as criteria', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answers: { q: { type: 'score', score: 1.6, confidence: 0.4 } } }),
      });
      globalThis.fetch = fetchMock;
      const result = await decisionAsk({ kind: 'score', question: 'How complete?', levels: ['low', 'mid', 'high'] });
      expect(result).toEqual({ score: 1.6, confidence: 0.4 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.questions.q).toEqual({
        type: 'score',
        instructions: 'How complete?',
        criteria: ['low', 'mid', 'high'],
      });
    });

    it('answers a one-option choice locally without a request (the API 422s on it)', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
      const result = await decisionAsk({
        kind: 'choice',
        question: 'only one way',
        options: [{ key: 'keep', description: 'the only option' }],
      });
      expect(result).toEqual({ choice: 'keep', confidence: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the pre-rename JEV_* gating env vars as deprecated aliases', async () => {
      delete process.env.DECISION_DRY_RUN;
      process.env.JEV_DRY_RUN = '1';
      expect(isDecisionDryRun()).toBe(true);
      process.env.DECISION_DRY_RUN = '0';
      expect(isDecisionDryRun()).toBe(false); // the new name wins when set
    });

    it('retries on 5xx up to DECISION_MAX_RETRIES times', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) return { ok: false, status: 503 };
        return {
          ok: true,
          json: async () => ({ answers: { q: { type: 'choice', choice: 'yes', confidence: 0.8 } } }),
        };
      });
      process.env.DECISION_MAX_RETRIES = '3';

      const q = {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'yes', description: 'y' },
          { key: 'no', description: 'n' },
        ],
      };
      const result = await decisionAsk(q);
      expect(result.choice).toBe('yes');
      expect(calls).toBe(3);
    });

    it('throws after exhausting retries', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      process.env.DECISION_MAX_RETRIES = '1';

      const q = {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'yes', description: 'y' },
          { key: 'no', description: 'n' },
        ],
      };
      await expect(decisionAsk(q)).rejects.toThrow(/Decision/);
    });
  });
});
