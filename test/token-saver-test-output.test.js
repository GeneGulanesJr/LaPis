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
      ].join('\n'),
      result = compressTestOutput({ stdout: output, stderr: '', exitCode: 1 });
    expect(result.summary).toContain('failed');
    expect(result.importantOutput).toContain('FAIL');
    expect(result.importantOutput).toContain('Expected: 401');
    expect(result.importantOutput).toContain('Received: 500');
    expect(result.importantOutput).toContain('Test Suites');
    expect(result.importantOutput).not.toContain('✓ adds numbers');
  });

  it('keeps every failure block, not just the last (#381)', () => {
    const pytest = [
        'FAILED tests/test_a.py::test_one - AssertionError',
        'FAILED tests/test_a.py::test_two - AssertionError',
        'FAILED tests/test_a.py::test_three - AssertionError',
      ].join('\n'),
      jest = [
        'FAIL src/auth.test.js',
        '  ● login › rejects bad password',
        '    Expected: "ok"',
        '    Received: "auth failed"',
        'Tests: 1 failed, 1 total',
      ].join('\n'),
      py = compressTestOutput({ stdout: pytest, stderr: '', exitCode: 1 }).importantOutput,
      js = compressTestOutput({ stdout: jest, stderr: '', exitCode: 1 }).importantOutput;
    for (const name of ['test_one', 'test_two', 'test_three']) {
      expect(py).toContain(name);
    }
    for (const part of ['FAIL src/auth.test.js', 'login › rejects bad password', 'Expected: "ok"', 'auth failed']) {
      expect(js).toContain(part);
    }
  });

  it('handles all-pass output', () => {
    const output = ['PASS src/utils.test.js', '  ✓ test 1', '  ✓ test 2', '', 'Tests: 2 passed, 2 total'].join('\n'),
      result = compressTestOutput({ stdout: output, stderr: '', exitCode: 0 });
    expect(result.summary).toContain('passed');
    expect(result.importantOutput).toContain('Tests: 2 passed');
    expect(result.importantOutput).not.toContain('✓ test 1');
  });
});
