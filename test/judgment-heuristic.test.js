// vitest globals enabled — no import
const { createHeuristicAdapter } = require('../src/judgment/adapters/heuristic');

describe('heuristic adapter', () => {
  it('is the default provider name and probes healthy-off', async () => {
    const a = createHeuristicAdapter();
    expect(a.name).toBe('heuristic');
    const health = await a.probe();
    expect(health.ok).toBe(true);
    expect(health.mode).toBe('off');
  });
  it('always returns unavailable with a stable reason', async () => {
    const a = createHeuristicAdapter();
    const r = await a.judge([
      { id: 'q1', judgment: { kind: 'probability', claim: 'c' }, instructions: 'i', state: { s: 1 } },
    ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/judgments off/i);
    expect(r.answers).toBeUndefined();
  });
});
