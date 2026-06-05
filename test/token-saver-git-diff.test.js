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
});
