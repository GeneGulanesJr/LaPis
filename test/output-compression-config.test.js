const { resetConfigCache } = require('../config');

describe('output compression config defaults', () => {
  test('getConfig includes output_compression defaults', () => {
    // Force reload of config to pick up defaults
    resetConfigCache();
    const { getConfig } = require('../config');
    const config = getConfig();
    expect(config.output_compression).toBeDefined();
    expect(config.output_compression.enabled).toBe(true);
    expect(config.output_compression.min_chars).toBe(2000);
    expect(config.output_compression.min_savings_percent).toBe(30);
  });
});
