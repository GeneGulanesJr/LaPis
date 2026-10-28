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
      ].join('\n'),
      result = compressSearchOutput({
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
    const lines = [],
      result = (() => {
        for (let i = 0; i < 100; i++) {
          lines.push(`file${i % 5}.js:${i + 1}:TODO: item ${i}`);
        }

        return compressSearchOutput({
          stdout: lines.join('\n'),
          stderr: '',
          exitCode: 0,
          commandArgs: ['rg', 'TODO'],
        });
      })();
    expect(result.summary).toContain('100 match');
  });
});

describe('compress-search-output without line numbers (#382)', () => {
  it('shows grep -l / no -n output instead of reporting 0 matches', () => {
    const stdout = ['src/a.js:TODO fix', 'src/b.js:TODO later', 'src/c.js'].join('\n'),
      result = compressSearchOutput({ stdout, stderr: '', exitCode: 0, commandArgs: ['grep', '-r', 'TODO', 'src'] });
    expect(result.importantOutput).toContain('src/a.js:TODO fix');
    expect(result.importantOutput).toContain('src/c.js');
  });

  it('caps the extra lines', () => {
    const stdout = Array.from({ length: 80 }, (_, i) => `file${i}.js`).join('\n'),
      result = compressSearchOutput({ stdout, stderr: '', exitCode: 0, commandArgs: ['grep', '-l', 'x'] });
    expect(result.importantOutput).toContain('file49.js');
    expect(result.importantOutput).not.toContain('file50.js');
    expect(result.importantOutput).toContain('30 more lines not shown');
  });
});
