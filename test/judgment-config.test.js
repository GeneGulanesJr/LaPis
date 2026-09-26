// vitest globals enabled — no import
const { getConfig, resetConfigCache } = require('../config');

describe('judgment config section', () => {
  afterEach(() => {
    delete process.env.LAPIS_JUDGE_PROVIDER;
    delete process.env.LAPIS_JUDGE_LOCAL_ONLY;
    delete process.env.LAPIS_JUDGE_DISABLE_DREAM;
    delete process.env.LAPIS_JUDGE_TIMEOUT_MS;
    resetConfigCache();
  });

  it('defaults to heuristic (OFF) per zero-cloud ethos (spec §4)', () => {
    const j = getConfig().judgment;
    expect(j.provider).toBe('heuristic');
    expect(j.local_only).toBe(false);
    expect(j.timeout_ms).toBe(5000);
    expect(j.max_retries).toBe(2);
    expect(j.confident_threshold).toBe(0.6);
    expect(j.breaker_threshold).toBe(3);
    expect(j.breaker_cooldown_ms).toBe(60000);
    expect(j.disables).toEqual({});
  });
  it('LAPIS_JUDGE_PROVIDER=jev opts in', () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    resetConfigCache();
    expect(getConfig().judgment.provider).toBe('jev');
  });
  it('LAPIS_JUDGE_LOCAL_ONLY=1 forces the kill switch', () => {
    process.env.LAPIS_JUDGE_LOCAL_ONLY = '1';
    resetConfigCache();
    expect(getConfig().judgment.local_only).toBe(true);
  });
  it('LAPIS_JUDGE_DISABLE_<SURFACE> lands in disables (lowercased)', () => {
    process.env.LAPIS_JUDGE_DISABLE_DREAM = '1';
    resetConfigCache();
    expect(getConfig().judgment.disables.dream).toBe(true);
  });
  it('numeric env overrides parse', () => {
    process.env.LAPIS_JUDGE_TIMEOUT_MS = '2500';
    resetConfigCache();
    expect(getConfig().judgment.timeout_ms).toBe(2500);
  });
});
