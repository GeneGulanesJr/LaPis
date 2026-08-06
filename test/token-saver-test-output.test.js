const { compressTestOutput } = require('../src/token-saver/rules/test-output');

describe('compress-test-output', () => {
  it('handles empty output', () => {
    const result = compressTestOutput({ stdout: '', stderr: '', exitCode: 0 });
    expect(result.summary).toContain('passed');
    expect(result.importantOutput).toBe('');
  });

  it('extracts failures and summary from jest-like output', () => {
    const output = [
      'PASS src/utils.test.js',
      '  ✓ adds numbers (2ms)',
      '  ✓ subtracts numbers (1ms)',
      'FAIL src/auth.test.js',
      '  ✕ rejects invalid token (5ms)',
      '  Expected: 401',
      '  Received: 500',
      '',
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       1 failed, 2 passed, 3 total',
    ].join('\n');

    const result = compressTestOutput({ stdout: output, stderr: '', exitCode: 1 });
    expect(result.summary).toContain('failed');
    expect(result.importantOutput).toContain('FAIL');
    expect(result.importantOutput).toContain('Expected: 401');
    expect(result.importantOutput).toContain('Received: 500');
    expect(result.importantOutput).toContain('Test Suites');
    expect(result.importantOutput).not.toContain('✓ adds numbers');
  });

  it('handles all-pass output', () => {
    const output = ['PASS src/utils.test.js', '  ✓ test 1', '  ✓ test 2', '', 'Tests: 2 passed, 2 total'].join('\n');

    const result = compressTestOutput({ stdout: output, stderr: '', exitCode: 0 });
    expect(result.summary).toContain('passed');
    expect(result.importantOutput).toContain('Tests: 2 passed');
    expect(result.importantOutput).not.toContain('✓ test 1');
  });
});
