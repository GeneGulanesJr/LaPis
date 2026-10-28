const { resolveProjectForCwd } = require('../../src/claude-code/project-resolve');

describe('claude-code project-resolve', () => {
  const repos = [{ name: 'my-monorepo', path: '/repos/my-monorepo' }],
    knownProjects = ['legacy-app'];

  test('resolveProjectForCwd prefers indexed repo path over basename', () => {
    const { project, resolvedCwd } = resolveProjectForCwd(
      '/repos/my-monorepo/packages/foo',
      () => repos,
      () => knownProjects,
    );
    // ResolveCwd returns an absolute path, which gains a drive letter on Windows.
    expect(resolvedCwd).toBe(require('path').resolve('/repos/my-monorepo/packages/foo'));
    expect(project).toBe('my-monorepo');
  });

  test('resolveProjectForCwd uses knownProjects when no code repo matches', () => {
    const { project } = resolveProjectForCwd(
      '/home/me/legacy-app/src',
      () => [],
      () => knownProjects,
    );
    expect(project).toBe('legacy-app');
  });
});
