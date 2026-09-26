// vitest globals enabled — no import; `vi` is a global
const { shouldAutoCaptureWithJudge } = require('../src/hooks-engine/pattern-matcher');

const DECISION_TEXT =
  'I have analyzed the options and I am going with vitest for the test runner because mutation-score diffing needs per-file filtering and the team already knows vitest. Final answer: vitest everywhere, decided.';
const PLAIN_TEXT =
  'Ran the test suite, all 355 tests pass. Also fixed a typo in the README and updated the changelog date. Nothing decision-like here at all, just routine maintenance work and output.';

describe('shouldAutoCaptureWithJudge — regex-first cascade', () => {
  it('high-confidence regex match: returns unchanged, judge NEVER called', async () => {
    const judge = vi.fn();
    const r = await shouldAutoCaptureWithJudge(DECISION_TEXT, { judge });
    expect(r.match).toBe(true);
    expect(r.pattern.type).toBe('decision');
    expect(judge).not.toHaveBeenCalled();
  });
  it('no judge provided + no regex match → identical to today (match:false, low)', async () => {
    const r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, {});
    expect(r).toEqual({ match: false, confidence: 'low' });
  });
  it('no regex match + judge says decision (>= floor) → judgment-sourced match', async () => {
    const judge = vi.fn(async () => ({
      status: 'ok',
      answers: [{ id: 'autosave-0', pick: 'decision', confidence: 0.9 }],
    }));
    const r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, { judge });
    expect(r.match).toBe(true);
    expect(r.source).toBe('judgment');
    expect(r.pattern.type).toBe('decision');
    expect(r.confidence).toBe('medium');
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][1]).toEqual({ surface: 'autosave' });
  });
  it('no regex match + judge says nothing → no match, as today', async () => {
    const judge = vi.fn(async () => ({
      status: 'ok',
      answers: [{ id: 'autosave-0', pick: 'nothing', confidence: 0.95 }],
    }));
    const r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, { judge });
    expect(r).toEqual({ match: false, confidence: 'low' });
  });
  it('no regex match + judgment below floor → no match', async () => {
    const judge = vi.fn(async () => ({
      status: 'ok',
      answers: [{ id: 'autosave-0', pick: 'bugfix', confidence: 0.3 }],
    }));
    const r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, { judge, floor: 0.6 });
    expect(r).toEqual({ match: false, confidence: 'low' });
  });
  it('unavailable/invalid/thrown judgment → no match, never throws', async () => {
    for (const impl of [
      async () => ({ status: 'unavailable', reason: 'off' }),
      async () => ({ status: 'invalid', reason: 'bad' }),
      async () => {
        throw new Error('boom');
      },
    ]) {
      const r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, { judge: vi.fn(impl) });
      expect(r).toEqual({ match: false, confidence: 'low' });
    }
  });
  it('short text skips judgment entirely (same early-return as shouldAutoCapture)', async () => {
    const judge = vi.fn();
    const r = await shouldAutoCaptureWithJudge('too short', { judge });
    expect(r).toEqual({ match: false, confidence: 'low' });
    expect(judge).not.toHaveBeenCalled();
  });
});
