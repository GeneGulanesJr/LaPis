const { assembleContextLines } = require('../../src/claude-code/context-inject');

describe('claude-code context-inject', () => {
  const EMPTY_CONTEXT = {
    observations: [],
    personal: [],
    stats: { total_memories: 0, total_personal: 0 },
  };

  test('assembleContextLines honors CLAUDE_PROJECT_DIR for repo matching', async () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/resolved/project';
    try {
      const repos = [{ name: 'app', path: '/resolved/project', indexed_at: 'now' }],
        assembled = await assembleContextLines({
          dispatch: async () => EMPTY_CONTEXT,
          getKnownRepos: () => repos,
          project: 'app',
          cwd: '/ignored/subdir',
          query: null,
          sessionId: null,
        });
      expect(assembled?.cwdRepo?.name).toBe('app');
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = prev;
      }
    }
  });
});
