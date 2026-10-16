import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jevAsk, isJevDryRun } from '../extensions/memory-layer/host/jev-client.ts';

describe('jev-client', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.JEV_DRY_RUN;
    delete process.env.JEV_TIMEOUT_MS;
    delete process.env.JEV_MAX_RETRIES;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('isJevDryRun', () => {
    it('returns true when JEV_DRY_RUN=1', () => {
      process.env.JEV_DRY_RUN = '1';
      expect(isJevDryRun()).toBe(true);
    });

    it('returns false when JEV_DRY_RUN unset', () => {
      expect(isJevDryRun()).toBe(false);
    });
  });

  describe('jevAsk dry-run', () => {
    beforeEach(() => {
      process.env.JEV_DRY_RUN = '1';
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
      const result = await jevAsk(q);
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
      const result = await jevAsk(q);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThan(4);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('throws on unknown question kind', async () => {
      await expect(jevAsk({ kind: 'unknown' })).rejects.toThrow(/unknown question kind/);
    });
  });

  describe('jevAsk live (mocked fetch)', () => {
    beforeEach(() => {
      // Live mode requires a key to reach the fetch call; tests don't care about the value.
      process.env.JEV_API_KEY = 'test-key';
    });

    it('POSTs to the Jev endpoint with shape { questions: [...] } and unwraps the response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          answers: [{ choice: 'yes', confidence: 0.9 }],
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
      const result = await jevAsk(q);
      expect(result).toEqual({ choice: 'yes', confidence: 0.9 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        model: 'jev-latest',
        questions: [expect.objectContaining({ kind: 'choice' })],
      });
    });

    it('retries on 5xx up to JEV_MAX_RETRIES times', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) return { ok: false, status: 503 };
        return {
          ok: true,
          json: async () => ({ answers: [{ choice: 'yes', confidence: 0.8 }] }),
        };
      });
      process.env.JEV_MAX_RETRIES = '3';

      const q = {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'yes', description: 'y' },
          { key: 'no', description: 'n' },
        ],
      };
      const result = await jevAsk(q);
      expect(result.choice).toBe('yes');
      expect(calls).toBe(3);
    });

    it('throws after exhausting retries', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      process.env.JEV_MAX_RETRIES = '1';

      const q = {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'yes', description: 'y' },
          { key: 'no', description: 'n' },
        ],
      };
      await expect(jevAsk(q)).rejects.toThrow(/Jev/);
    });
  });
});
