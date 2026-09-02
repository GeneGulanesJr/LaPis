const { compressGeneric } = require('../src/token-saver/rules/generic');

describe('compress-generic', () => {
  it('handles empty output', () => {
    const result = compressGeneric({ stdout: '', stderr: '', exitCode: 0 });
    expect(result.summary).toBe('No output.');
  });

  it('keeps short output intact', () => {
    const result = compressGeneric({ stdout: 'hello\nworld', stderr: '', exitCode: 0 });
    expect(result.importantOutput).toBe('hello\nworld');
    expect(result.omittedLines).toBe(0);
  });

  it('compresses long output with head/tail', () => {
    const lines = [],
    result = (() => {

      for (let i = 0; i < 500; i++) {
        lines.push(`line ${i + 1}`);
      }
      
  return (compressGeneric({ stdout: lines.join('\n'), stderr: '', exitCode: 0 }));
})();expect(result.summary).toContain('compressed');
    expect(result.importantOutput).toContain('line 1');
    expect(result.importantOutput).toContain('line 500');
    expect(result.importantOutput).toContain('260 lines omitted');
    expect(result.omittedLines).toBe(260);
  });

  it('extracts important lines from long output', () => {
    const lines = [],
    result = (() => {

      for (let i = 0; i < 500; i++) {
        if (i === 200) {
          lines.push('ERROR: something broke');
        } else {
          lines.push(`line ${i + 1}`);
        }
      }
      
  return (compressGeneric({ stdout: lines.join('\n'), stderr: '', exitCode: 0 }));
})();expect(result.importantOutput).toContain('ERROR: something broke');
    expect(result.importantOutput).toContain('line 201');
  });
});
