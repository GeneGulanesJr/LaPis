const { compressSearchOutput } = require('../src/token-saver/rules/search');

describe('compress-search-output', () => {
  it('handles no matches', () => {
    const result = compressSearchOutput({ stdout: '', stderr: '', exitCode: 0, commandArgs: ['grep', 'TODO'] });
    expect(result.summary).toBe('No matches.');
  });

  it('groups matches by file with line numbers', () => {
    const output = [
      'src/index.js:82:TODO: handle deleted files',
      'src/index.js:194:TODO: add debounce',
      'src/http/server.js:120:TODO: auth',
      'src/http/server.js:200:FIXME: broken',
    ].join('\n');

    const result = compressSearchOutput({
      stdout: output,
      stderr: '',
      exitCode: 0,
      commandArgs: ['grep', 'TODO', '-R', '.'],
    });
    expect(result.summary).toContain('4 match');
    expect(result.summary).toContain('2 file');
    expect(result.importantOutput).toContain('src/index.js');
    expect(result.importantOutput).toContain('L82');
    expect(result.importantOutput).toContain('L194');
    expect(result.importantOutput).toContain('src/http/server.js');
    expect(result.importantOutput).toContain('L120');
  });

  it('truncates when too many matches', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`file${i % 5}.js:${i + 1}:TODO: item ${i}`);
    }
    const result = compressSearchOutput({
      stdout: lines.join('\n'),
      stderr: '',
      exitCode: 0,
      commandArgs: ['rg', 'TODO'],
    });
    expect(result.summary).toContain('100 match');
  });
});
