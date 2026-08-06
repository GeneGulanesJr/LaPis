const { executeAndCompress } = require('../src/token-saver/index');

describe('token-saver integration', () => {
  it('executes node -e and returns structured result', async () => {
    const result = await executeAndCompress(['node', '-e', "console.log('hello')"]);
    expect(result.command).toBe("node -e console.log('hello')");
    expect(result.exitCode).toBe(0);
    expect(result.commandType).toBe('generic');
    expect(result.importantOutput).toContain('hello');
    expect(result.originalChars).toBeGreaterThan(0);
    expect(result.estimatedOriginalTokens).toBeGreaterThan(0);
    expect(typeof result.savingsPercent).toBe('number');
  });

  it('captures stderr and non-zero exit code', async () => {
    const result = await executeAndCompress(['node', '-e', "console.error('err'); process.exit(1)"]);
    expect(result.exitCode).toBe(1);
    expect(result.importantOutput).toContain('err');
  });

  it('respects raw mode', async () => {
    const result = await executeAndCompress(['node', '-e', "console.log('hello')"], { raw: true });
    expect(result.savingsPercent).toBe(0);
    expect(result.summary).toContain('Raw');
  });

  it('classifies git diff', async () => {
    const result = await executeAndCompress(['git', 'diff', '--stat']);
    expect(result.commandType).toBe('git-diff');
  });

  it('classifies git status', async () => {
    const result = await executeAndCompress(['git', 'status', '--porcelain']);
    expect(result.commandType).toBe('git-status');
  });

  it('handles timeout', async () => {
    const result = await executeAndCompress(['node', '-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
  }, 15000);
});
