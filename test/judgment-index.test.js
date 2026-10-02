// vitest globals enabled — no import; `vi` is a global
const { createJudge } = require('../src/judgment/index');

const q = { id: 'a', judgment: { kind: 'probability', claim: 'c' }, instructions: 'i', state: { s: 1 } };

function fakeConfig(over = {}) {
  return {
    judgment: {
      provider: 'jev',
      timeout_ms: 50,
      breaker_threshold: 2,
      breaker_cooldown_ms: 100,
      disables: {},
      ...over,
    },
  };
}

describe('createJudge — total-function guarantee (spec §7)', () => {
  it('provider off → unavailable without constructing an adapter', async () => {
    const j = createJudge({ config: fakeConfig({ provider: 'off' }), adapters: {} });
    const r = await j.judge([q]);
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/off/) });
  });
  it('unknown provider → unavailable, never throws', async () => {
    const j = createJudge({ config: fakeConfig({ provider: 'mystery' }), adapters: {} });
    const r = await j.judge([q]);
    expect(r.status).toBe('unavailable');
  });
  it('local_only kill switch forces unavailable even with jev selected', async () => {
    const spy = { judge: vi.fn(async () => ({ status: 'ok', answers: [{ id: 'a', p: 0.1, confidence: 0.9 }] })) };
    const j = createJudge({ config: fakeConfig({ local_only: true }), adapters: { jev: spy } });
    const r = await j.judge([q]);
    expect(r.status).toBe('unavailable');
    expect(spy.judge).not.toHaveBeenCalled();
  });
  it('disabled surface → unavailable', async () => {
    const j = createJudge({ config: fakeConfig({ disables: { dream: true } }), adapters: {} });
    const r = await j.judge([q], { surface: 'dream' });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/dream/);
  });
  it('hanging adapter → unavailable at timeout (never throws)', async () => {
    const hanging = { name: 'jev', judge: () => new Promise(() => {}) };
    const j = createJudge({ config: fakeConfig(), adapters: { jev: hanging } });
    const r = await j.judge([q]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/timeout/i);
  });
  it('happy path passes adapter answers through', async () => {
    const ok = {
      name: 'jev',
      judge: vi.fn(async () => ({ status: 'ok', answers: [{ id: 'a', p: 0.25, confidence: 0.8 }] })),
    };
    const j = createJudge({ config: fakeConfig(), adapters: { jev: ok } });
    const r = await j.judge([q]);
    expect(r.status).toBe('ok');
    expect(r.answers[0].p).toBe(0.25);
  });
});

describe('circuit breaker', () => {
  it('opens after threshold consecutive failures; calls skip the adapter; recovers after cooldown', async () => {
    vi.useFakeTimers();
    const failing = { name: 'jev', judge: vi.fn(async () => ({ status: 'unavailable', reason: 'HTTP 503' })) };
    const j = createJudge({
      config: fakeConfig({ breaker_threshold: 2, breaker_cooldown_ms: 100 }),
      adapters: { jev: failing },
    });
    await j.judge([q]);
    await j.judge([q]);
    expect(failing.judge).toHaveBeenCalledTimes(2);
    const open = await j.judge([q]);
    expect(open.reason).toMatch(/breaker open/i);
    expect(failing.judge).toHaveBeenCalledTimes(2); // adapter skipped while open
    vi.advanceTimersByTime(150);
    // after cooldown the breaker half-opens and tries again. Keep fake timers
    // installed for this call: the fake clock (T0+150) is deterministically
    // past openUntil (T0+100). Restoring real timers first would leave
    // Date.now() only a few real ms past T0 — inside the 100ms cooldown — and
    // the breaker would still read open (flaky). Restore after asserting.
    const r = await j.judge([q]);
    expect(failing.judge).toHaveBeenCalledTimes(3);
    expect(r.status).toBe('unavailable'); // still failing upstream, but attempted
    vi.useRealTimers();
  });
});

it('heuristic default: createJudge() with no adapters uses heuristic and is unavailable', async () => {
  const j = createJudge({
    config: {
      judgment: { provider: 'heuristic', timeout_ms: 50, breaker_threshold: 3, breaker_cooldown_ms: 100, disables: {} },
    },
  });
  const r = await j.judge([q]);
  expect(r.status).toBe('unavailable');
});
