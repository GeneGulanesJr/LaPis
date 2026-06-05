const { compressInstallOutput } = require('../src/token-saver/rules/install-output');

describe('compress-install-output', () => {
  it('handles empty output', () => {
    const result = compressInstallOutput({ stdout: '', stderr: '', exitCode: 0 });
    expect(result.summary).toContain('completed');
  });

  it('extracts warnings and errors', () => {
    const output = [
      'npm WARN deprecated package@1.0.0',
      'npm WARN peer dep mismatch: react@19 expected react@18',
      'npm ERR! 404 Not Found',
      'added 150 packages in 5s',
      '3 vulnerabilities (1 high, 2 moderate)',
      'downloading...',
      'extracting...',
    ].join('\n');

    const result = compressInstallOutput({ stdout: output, stderr: '', exitCode: 1 });
    expect(result.importantOutput).toContain('deprecated');
    expect(result.importantOutput).toContain('peer dep');
    expect(result.importantOutput).toContain('404');
    expect(result.importantOutput).toContain('added 150');
    expect(result.importantOutput).toContain('vulnerabilities');
    expect(result.omittedLines).toBeGreaterThan(0);
  });
});
