import { ensureNativeModules } from '../extensions/memory-layer/host/native-health.ts';
import { state } from '../extensions/memory-layer/state.ts';

describe('native-health', () => {
  it('should skip when already checked', async () => {
    state.nativeChecked = true;
    await ensureNativeModules();
    expect(state.nativeChecked).toBe(true);
    state.nativeChecked = false;
  });
});
