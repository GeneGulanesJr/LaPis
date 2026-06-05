import { state } from '../extensions/memory-layer/state.ts';

describe('output compression state', () => {
  test('state has compressionStats counters', () => {
    expect(state.compressionStats).toBeDefined();
    expect(state.compressionStats.totalRuns).toBe(0);
    expect(state.compressionStats.totalOriginalTokens).toBe(0);
    expect(state.compressionStats.totalCompressedTokens).toBe(0);
    expect(state.compressionStats.totalSavedTokens).toBe(0);
  });
});
