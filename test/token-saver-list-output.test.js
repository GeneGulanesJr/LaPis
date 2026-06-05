const { compressListOutput } = require('../src/token-saver/rules/list-output');

describe('compress-list-output', () => {
  it('handles empty output', () => {
    const result = compressListOutput({ stdout: '', stderr: '', exitCode: 0 });
    expect(result.summary).toBe('No output.');
  });

  it('collapses node_modules and .git', () => {
    const output = [
      'src/',
      'src/index.js',
      'src/utils.js',
      'node_modules/',
      'node_modules/express/index.js',
      'node_modules/express/lib/router.js',
      '.git/',
      '.git/HEAD',
      'tests/',
      'tests/test.js',
    ].join('\n');

    const result = compressListOutput({ stdout: output, stderr: '', exitCode: 0 });
    expect(result.importantOutput).toContain('src/');
    expect(result.importantOutput).toContain('tests/');
    expect(result.importantOutput).toContain('Collapsed');
    expect(result.importantOutput).toContain('node_modules');
    expect(result.omittedLines).toBeGreaterThan(0);
  });
});
