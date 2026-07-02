const { runHook } = require('../../src/claude-code/hooks');

// Integration-level coverage for the router's dependency-injection seams (#231):
// opts.stateStore and opts.dispatchClient must be honored end-to-end, not only
// opts.dispatch / opts.getKnownRepos. The existing handlers.test.js exercises
// handlers directly with a fake store; these run the full runHook path.

function fakeStateStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  const defaults = () => ({ editedFiles: [], exploredFiles: [], memoriesSavedThisSession: 0 });
  return {
    defaultState: defaults,
    loadState: (id) => map.get(id) || defaults(),
    saveState: (id, s) => map.set(id, s),
    mutateState: async (id, mutator) => {
      const s = map.get(id) || defaults();
      const r = await mutator(s);
      map.set(id, s);
      return r;
    },
    _peek: (id) => map.get(id),
  };
}

describe('claude-code router injection seams', () => {
  test('runHook honors opts.stateStore for a PostToolUse edit-track', async () => {
    const stateStore = fakeStateStore();
    const dispatch = async () => ({ ok: true });
    await runHook(['hook', 'PostToolUse'], {
      ensureDb: false,
      stdin: JSON.stringify({
        session_id: 'inj-1',
        tool_name: 'Write',
        tool_input: { file_path: '/proj/app/src/y.js' },
        cwd: '/proj/app',
      }),
      dispatch,
      getKnownRepos: () => [],
      stateStore,
    });
    expect(stateStore._peek('inj-1').editedFiles).toContain('/proj/app/src/y.js');
  });

  test('runHook honors opts.dispatchClient as the dispatched client', async () => {
    const dispatched = [];
    const fakeDispatchClient = {
      dispatch: async (cmd, args) => {
        dispatched.push(cmd);
        return cmd === 'session-start' ? { sessionId: 77 } : { observations: [] };
      },
      getKnownRepos: () => [],
    };
    await runHook(['hook', 'SessionStart'], {
      ensureDb: false,
      stdin: JSON.stringify({ session_id: 'inj-2', source: 'startup', cwd: '/proj/app' }),
      dispatchClient: fakeDispatchClient,
      stateStore: fakeStateStore(),
    });
    expect(dispatched).toContain('session-start');
  });
});

describe('claude-code router usage', () => {
  test('runHook without a leading "hook" token prints usage and sets exit code 2', async () => {
    const origExitCode = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };
    try {
      process.exitCode = undefined;
      // argv[0] must be the literal 'hook' token (cli.js guards on sub === 'hook'
      // before delegating here). A missing/unknown subcommand no longer reaches
      // runHook — it gets a top-level claude-code usage message in cli.js instead.
      await runHook(['bogus', 'SessionStart'], { ensureDb: false, stdin: '' });
      expect(stderrChunks.join('')).toContain('Usage: lapis claude-code hook');
      expect(process.exitCode).toBe(2);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = origExitCode;
    }
  });
});
