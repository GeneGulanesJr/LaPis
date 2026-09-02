// Tests that LAPIS_ASYNC_INDEX_THRESHOLD overrides async_index_file_threshold,
// Closing the gap where the env var was documented but never read.
const { applyEnvOverrides, DEFAULTS, loadConfig } = require('../config');

describe('LAPIS_ASYNC_INDEX_THRESHOLD env override', () => {
  const original = process.env.LAPIS_ASYNC_INDEX_THRESHOLD;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LAPIS_ASYNC_INDEX_THRESHOLD;
    } else {
      process.env.LAPIS_ASYNC_INDEX_THRESHOLD = original;
    }
  });

  it('overrides the configured value when the env var is a positive integer', () => {
    process.env.LAPIS_ASYNC_INDEX_THRESHOLD = '42';
    const config = { async_index_file_threshold: DEFAULTS.async_index_file_threshold };
    applyEnvOverrides(config);
    expect(config.async_index_file_threshold).toBe(42);
  });

  it('leaves the configured value untouched when the env var is unset', () => {
    delete process.env.LAPIS_ASYNC_INDEX_THRESHOLD;
    const config = { async_index_file_threshold: 999 };
    applyEnvOverrides(config);
    expect(config.async_index_file_threshold).toBe(999);
  });

  it('ignores non-numeric or non-positive values (falls back to configured)', () => {
    for (const bad of ['', 'not-a-number', '0', '-5', '3.7']) {
      process.env.LAPIS_ASYNC_INDEX_THRESHOLD = bad;
      const config = { async_index_file_threshold: 777 };
      applyEnvOverrides(config);
      expect(config.async_index_file_threshold).toBe(777);
    }
  });

  it('flows through loadConfig() (env > jsonc > default)', () => {
    // LoadConfig falls back to DEFAULTS when no config.jsonc is present in the
    // Test environment; the env override must still apply to that fallback.
    process.env.LAPIS_ASYNC_INDEX_THRESHOLD = '13';
    const cfg = loadConfig();
    expect(cfg.async_index_file_threshold).toBe(13);
  });
});
