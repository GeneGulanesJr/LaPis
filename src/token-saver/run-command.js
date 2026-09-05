const { spawn } = require('child_process'),
  DEFAULT_TIMEOUT_MS = 120000,
  DEFAULT_MAX_BUFFER_CHARS = 2_000_000;

function shellEscape(arg) {
  if (/[^A-Za-z0-9_\/:.\-]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}

function runCommand(commandArgs, options = {}) {
  return new Promise((resolve) => {
    const {
        cwd = process.cwd(),
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxBufferChars = DEFAULT_MAX_BUFFER_CHARS,
        env = process.env,
      } = options,
      isWindows = process.platform === 'win32';
    let child,
      stdout = '',
      stderr = '',
      truncated = false,
      killed = false,
      timer = null;

    if (isWindows) {
      child = spawn('cmd', ['/c', ...commandArgs], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      const escaped = commandArgs.map(shellEscape).join(' ');
      // Detached: the command becomes its own process-group leader so the
      // timeout kill below can take down pipeline grandchildren. Killing only
      // the shell leaves grandchildren alive holding the stdio pipe write
      // ends, and then 'close' never fires and this promise never resolves.
      child = spawn('/bin/sh', ['-c', escaped], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    }

    // setEncoding decodes through a StringDecoder, so a multi-byte character
    // split across two 'data' chunks no longer becomes U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      // Keep draining after the cap and discard — pausing the stream would
      // block the child on a full pipe, and 'close' would only fire after the
      // timeout SIGKILL (misreporting finished commands as timed out).
      if (stdout.length < maxBufferChars) {
        stdout += chunk;
        if (stdout.length >= maxBufferChars) {
          truncated = true;
          stdout = stdout.slice(0, maxBufferChars);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBufferChars) {
        stderr += chunk;
        if (stderr.length >= maxBufferChars) {
          truncated = true;
          stderr = stderr.slice(0, maxBufferChars);
        }
      }
    });

    timer = setTimeout(() => {
      killed = true;
      if (isWindows) {
        child.kill('SIGKILL');
        return;
      }
      // Kill the entire process group; fall back to the direct kill if the
      // group is already gone (leader exited, no other members).
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: killed ? null : (code ?? 0),
        truncated,
        timedOut: killed,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}\n${err.message}`,
        exitCode: 1,
        truncated,
        timedOut: false,
      });
    });
  });
}

module.exports = { runCommand, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BUFFER_CHARS };
