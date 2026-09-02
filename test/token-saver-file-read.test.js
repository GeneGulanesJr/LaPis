const { compressFileRead } = require('../src/token-saver/rules/file-read');

describe('compress-file-read', () => {
  it('keeps short output intact', () => {
    const result = compressFileRead({ stdout: 'line1\nline2\nline3', stderr: '', exitCode: 0 });
    expect(result.importantOutput).toContain('line1');
    expect(result.importantOutput).toContain('line3');
    expect(result.omittedLines).toBe(0);
  });

  it('compresses long output with head/tail', () => {
    const lines = [],
    result = (() => {

      for (let i = 0; i < 500; i++) {
        lines.push(`line ${i + 1}`);
      }
      
  return (compressFileRead({ stdout: lines.join('\n'), stderr: '', exitCode: 0 }));
})();expect(result.summary).toContain('compressed');
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.importantOutput).toContain('line 1');
    expect(result.importantOutput).toContain('line 500');
  });

  it('extracts important lines', () => {
    const lines = [],
    result = (() => {

      for (let i = 0; i < 500; i++) {
        if (i === 250) {
          lines.push('ERROR: something failed');
        } else {
          lines.push(`line ${i + 1}`);
        }
      }
      
  return (compressFileRead({ stdout: lines.join('\n'), stderr: '', exitCode: 0 }));
})();expect(result.importantOutput).toContain('ERROR: something failed');
    expect(result.summary).toContain('important');
  });
});
