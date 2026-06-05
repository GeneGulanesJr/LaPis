const { compressLogs } = require('../src/token-saver/rules/logs');

describe('compress-logs', () => {
  it('handles empty output', () => {
    const result = compressLogs({ stdout: '', stderr: '', exitCode: 0 });
    expect(result.summary).toContain('No log');
  });

  it('deduplicates recurring lines and extracts errors', () => {
    const lines = [];
    for (let i = 0; i < 42; i++) {
      lines.push('2026-06-05 12:00:00 Database is locked');
    }
    lines.push('2026-06-05 12:01:00 HTTP 500 error at /api/users');
    lines.push('2026-06-05 12:01:22 Server started successfully');

    const result = compressLogs({ stdout: lines.join('\n'), stderr: '', exitCode: 0 });
    expect(result.summary).toContain('44 log');
    expect(result.summary).toContain('error');
    expect(result.summary).toContain('recurring');
    expect(result.importantOutput).toContain('42x');
    expect(result.importantOutput).toContain('HTTP 500');
    expect(result.importantOutput).toContain('2026-06-05 12:01');
    expect(result.omittedLines).toBeGreaterThan(0);
  });
});
