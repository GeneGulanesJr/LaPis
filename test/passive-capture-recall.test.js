// #394: unused search results are logged as not useful once per agent run, not per turn.
import { registerPassiveCapture } from '../extensions/memory-layer/hooks/passive-capture.ts';

describe('recall feedback flush', () => {
  test('flushes on agent_end, not turn_end', async () => {
    const handlers = new Map(),
      pi = { on: (name, cb) => handlers.set(name, cb) },
      state = {
        turnCount: 0,
        dreamTriggeredThisSession: true,
        currentProject: null,
        editedFiles: new Set(),
        pendingRecallFeedback: new Map([[7, { sessionId: 1, query: 'q' }]]),
      },
      mem = vi.fn(async () => ({}));
    registerPassiveCapture(pi, { state, mem, memCmd: vi.fn() });

    await handlers.get('turn_end')({}, {});
    expect(mem).not.toHaveBeenCalledWith('log-negative-recall', expect.anything());
    expect(state.pendingRecallFeedback.size).toBe(1);

    await handlers.get('agent_end')({}, {});
    expect(mem).toHaveBeenCalledWith('log-negative-recall', {
      entries: JSON.stringify([{ memoryId: 7, sessionId: 1, query: 'q', wasUseful: false }]),
    });
    expect(state.pendingRecallFeedback.size).toBe(0);
  });
});
