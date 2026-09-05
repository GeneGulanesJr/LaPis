// Regression tests for issue #280: runCommand used to pause stdout at the
// Buffer cap (blocking children on a full pipe), kill only the shell on
// Timeout (leaving pipeline grandchildren alive holding the pipe so 'close'
// Never fired → the promise hung forever), and decode each chunk
// Independently (splitting multi-byte UTF-8 into U+FFFD).
const { runCommand } = require('../src/token-saver/run-command');

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

describe('runCommand buffer cap + drain (#280)', () => {
  posixDescribe('process-group handling (POSIX)', () => {
    it('resolves when a pipeline output exceeds the cap (stream keeps draining)', async () => {
      const result = await runCommand(['sh', '-c', 'yes x | head -c 200000'], {
        maxBufferChars: 1000,
        timeoutMs: 15000,
      });
      expect(result.stdout).toHaveLength(1000);
      expect(result.truncated).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('timeout kills the whole process group so compound commands resolve', async () => {
      // `sleep 30 | cat`: after SIGKILL of the shell alone, cat survives
      // Holding the stdout write end and 'close' never fires. With the group
      // Kill, cat dies too and the promise resolves.
      const result = await runCommand(['sh', '-c', 'sleep 30 | cat'], {
        maxBufferChars: 1000000,
        timeoutMs: 500,
      });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
    }, 15000);
  });

  it('reports timeout for a stubborn child', async () => {
    const result = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 400,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 15000);

  it('preserves multi-byte characters split across chunk boundaries', async () => {
    // 你 = E4 BD A0. Write the first two bytes, flush, then the rest after a
    // Pause — the decoder must carry the partial sequence across chunks.
    const script =
      "process.stdout.write(Buffer.from([0xe4, 0xbd])); setTimeout(() => { process.stdout.write(Buffer.from([0xa0])); process.stdout.write('!'); }, 80)";
    const result = await runCommand([process.execPath, '-e', script], {
      maxBufferChars: 1000000,
      timeoutMs: 10000,
    });
    expect(result.stdout).toBe('你!');
    expect(result.timedOut).toBe(false);
  }, 15000);
});
