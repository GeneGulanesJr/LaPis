const { compressGitDiff } = require('../src/token-saver/rules/git-diff');

describe('compress-git-diff', () => {
  it('handles empty diff', () => {
    const result = compressGitDiff({ stdout: '', stderr: '', exitCode: 0 });
    expect(result.summary).toBe('No changes.');
    expect(result.importantOutput).toBe('');
  });

  it('extracts file list and hunk headers', () => {
    const output = [
      'diff --git a/src/foo.js b/src/foo.js',
      'index abc..def 100644',
      '--- a/src/foo.js',
      '+++ b/src/foo.js',
      '@@ -10,5 +10,6 @@ function bar() {',
      ' context line',
      '-removed line',
      '+added line',
      ' context line 2',
      ' context line 3',
      'diff --git a/src/bar.js b/src/bar.js',
      'index ghi..jkl 100644',
      '--- a/src/bar.js',
      '+++ b/src/bar.js',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-old',
      '+new',
      ' unchanged2',
    ].join('\n');

    const result = compressGitDiff({ stdout: output, stderr: '', exitCode: 0 });
    expect(result.summary).toContain('2 file(s) changed');
    expect(result.importantOutput).toContain('src/foo.js');
    expect(result.importantOutput).toContain('src/bar.js');
    expect(result.importantOutput).toContain('+1 -1');
  });

  it('hides lockfile diffs', () => {
    const output = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index abc..def 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,1000 +1,1000 @@',
    ].join('\n');

    const result = compressGitDiff({ stdout: output, stderr: '', exitCode: 0 });
    expect(result.summary).toContain('lockfile');
    expect(result.importantOutput).toContain('lockfile diff hidden');
  });

  it('reports each lockfile with its own line count across multiple lockfiles', () => {
    const lockA = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index abc..def 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,3 +1,3 @@',
      ' lock-content-a',
    ].join('\n');
    const lockB = [
      'diff --git a/yarn.lock b/yarn.lock',
      'index abc..def 100644',
      '--- a/yarn.lock',
      '+++ b/yarn.lock',
      '@@ -1,3 +1,3 @@',
      ' lock-content-b-1',
      ' lock-content-b-2',
      ' lock-content-b-3',
    ].join('\n');

    const result = compressGitDiff({ stdout: `${lockA}\n${lockB}`, stderr: '', exitCode: 0 });

    // Expected per-file counts: package-lock.json = 5 lines, yarn.lock = 7 lines.
    // Pre-fix bug: both lockfiles printed the combined total (12 lines).
    expect(result.importantOutput).toContain('package-lock.json: lockfile diff hidden (5 lines)');
    expect(result.importantOutput).toContain('yarn.lock: lockfile diff hidden (7 lines)');
    expect(result.importantOutput).not.toContain('(12 lines)');
  });
});
