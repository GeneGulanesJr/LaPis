const { resolveCwd, projectFromCwd, findMatchingRepo, findMatchingProject } = require('../../src/hooks-engine/project');

describe('hooks-engine project: resolveCwd', () => {
  afterEach(() => {
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  test('prefers explicit hint', () => {
    process.env.CLAUDE_PROJECT_DIR = '/from/env';
    expect(resolveCwd('/hint')).toBe('/hint');
  });

  test('falls back to CLAUDE_PROJECT_DIR', () => {
    process.env.CLAUDE_PROJECT_DIR = '/from/env';
    expect(resolveCwd()).toBe('/from/env');
  });

  test('falls back to process.cwd() when no env', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(resolveCwd()).toBe(process.cwd());
  });
});

describe('hooks-engine project: projectFromCwd', () => {
  test('basename lowercased', () => {
    expect(projectFromCwd('/foo/MyRepo')).toBe('myrepo');
  });

  test('default to cwd', () => {
    expect(projectFromCwd()).toBe(require('node:path').basename(process.cwd()).toLowerCase());
  });
});

describe('hooks-engine project: findMatchingRepo', () => {
  const repos = [
    { name: 'alpha', path: '/repos/alpha' },
    { name: 'beta', path: '/repos/beta/sub' },
  ];

  test('prefix match (case-insensitive)', () => {
    expect(findMatchingRepo('/repos/alpha/src', repos)?.name).toBe('alpha');
  });

  test('exact match', () => {
    expect(findMatchingRepo('/repos/beta/sub', repos)?.name).toBe('beta');
  });

  test('returns null when nothing matches', () => {
    expect(findMatchingRepo('/elsewhere', repos)).toBeNull();
  });

  test('does not false-match a sibling that merely shares a path prefix', () => {
    // Regression guard for #227: matching must require the platform separator
    // after the repo path. The fix switched from a hardcoded "/" to path.sep;
    // a sibling repo whose name is a textual extension of another's path
    // (/repos/alphabeta vs /repos/alpha) must NOT match. This boundary is the
    // same one that was broken on Windows, where a hardcoded "/" could not
    // separate a backslash-styled cwd from its repo.
    expect(findMatchingRepo('/repos/alphabeta', repos)).toBeNull();
  });
});

describe('hooks-engine project: findMatchingProject', () => {
  test('matches a directory basename in the up-tree', () => {
    expect(findMatchingProject('/home/me/lapis/src', ['lapis', 'other'])).toBe('lapis');
  });

  test('matches at a deeper level', () => {
    expect(findMatchingProject('/home/OtherApp/lib/deep', ['otherapp'])).toBe('otherapp');
  });

  test('returns null when no ancestor matches', () => {
    expect(findMatchingProject('/home/unknown', ['lapis'])).toBeNull();
  });
});
