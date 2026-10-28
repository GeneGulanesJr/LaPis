// Audit #18: the turn-10 checkpoint's post-edit audit needs deps.getKnownRepos +
// deps.findRepoForAnyFile. index.ts never passed findRepoForAnyFile, so the call
// threw inside a catch {} and audit-diff never ran.
import path from 'node:path';
import { vi } from 'vitest';

// Dashboard-tui imports a pi-only TUI package; stub it before memory-layer loads.
vi.mock('@earendil-works/pi-tui', () => ({ Key: {}, matchesKey: () => false, truncateToWidth: (s) => s }));
vi.mock('../extensions/memory-layer/hooks/passive-capture', async (importOriginal) => ({
  ...(await importOriginal()),
  registerPassiveCapture: vi.fn(),
}));

import memoryLayer from '../extensions/memory-layer/index.ts';
import { registerPassiveCapture } from '../extensions/memory-layer/hooks/passive-capture';

describe('passive-capture checkpoint audit', () => {
  test('index.ts wires the deps the turn-10 audit uses, and audit-diff runs', async () => {
    const noop = () => {},
      fakePi = {
        on: noop,
        registerTool: noop,
        registerCommand: noop,
        appendEntry: noop,
        sendMessage: noop,
        sendUserMessage: noop,
        setTools: noop,
        ui: { notify: noop },
      };
    memoryLayer(fakePi);
    const wired = registerPassiveCapture.mock.calls[0][1];

    const { registerPassiveCapture: realRegister } = await vi.importActual(
        '../extensions/memory-layer/hooks/passive-capture',
      ),
      handlers = new Map(),
      repoPath = path.resolve('/work/proj'),
      mem = vi.fn(async () => ({})),
      state = {
        turnCount: 9,
        dreamTriggeredThisSession: true,
        currentProject: 'proj',
        sessionId: 1,
        memoriesSavedThisSession: 0,
        editedFiles: new Set([path.join(repoPath, 'src', 'a.js')]),
        pendingRecallFeedback: new Map(),
      };
    realRegister(
      { on: (name, cb) => handlers.set(name, cb) },
      {
        state,
        mem,
        memCmd: vi.fn(),
        getKnownRepos: async () => [{ name: 'Proj', path: repoPath }],
        findRepoForAnyFile: wired.findRepoForAnyFile,
      },
    );

    await handlers.get('turn_end')({}, {});
    expect(mem).toHaveBeenCalledWith(
      'audit-diff',
      expect.objectContaining({ repo: 'Proj', task: 'checkpoint turn 10' }),
    );
    expect(typeof wired.getKnownRepos).toBe('function');
  });
});
