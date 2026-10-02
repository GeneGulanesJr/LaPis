const { spawn } = require('child_process'),
  DEFAULT_TIMEOUT_MS = 120000,
  DEFAULT_MAX_BUFFER_CHARS = 2_000_000;

function shellEscape(arg) {
  if (/[^A-Za-z0-9_\/:.\-]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}

// Only fires when the ENTIRE command arrives as a single argv element that
// contains a shell operator (pipe, redirect, `&&`/`||`, `;`, command
// substitution, backticks) — e.g. `lapis run 'git log --oneline | head -5'`,
// where process.argv already tokenized the whole pipeline into one element.
// In that shape there's nothing else it could mean: the caller quoted the
// whole thing as one word specifically so it travels as one unit, and the
// only sensible reading is "run this through a shell". shellEscape() would
// otherwise re-quote it into a single literal token, making /bin/sh try to
// exec a program named "git log --oneline | head -5" instead of running the
// pipeline. This intentionally does NOT trigger for multi-token commandArgs
// (e.g. ['sh', '-c', 'a | b'] or ['echo', 'a|b']), where a lone operator
// character inside one token is ambiguous with a literal value and the
// existing per-token escaping is the safer default.
const SHELL_OPERATOR_RE = /[|&;<>`]|\$\(/;

function isSingleShellExpression(commandArgs) {
  return commandArgs.length === 1 && SHELL_OPERATOR_RE.test(commandArgs[0]);
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
      // A lone single-token pipeline is passed through unescaped so the shell
      // interprets it; every other shape keeps the per-token escaping so
      // literal values (e.g. a commit message) survive round-tripping through
      // /bin/sh -c intact.
      const escaped = isSingleShellExpression(commandArgs) ? commandArgs[0] : commandArgs.map(shellEscape).join(' ');
      // Detached: the command becomes its own process-group leader so the
      // Timeout kill below can take down pipeline grandchildren. Killing only
      // The shell leaves grandchildren alive holding the stdio pipe write
      // Ends, and then 'close' never fires and this promise never resolves.
      child = spawn('/bin/sh', ['-c', escaped], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    }

    // SetEncoding decodes through a StringDecoder, so a multi-byte character
    // Split across two 'data' chunks no longer becomes U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      // Keep draining after the cap and discard — pausing the stream would
      // Block the child on a full pipe, and 'close' would only fire after the
      // Timeout SIGKILL (misreporting finished commands as timed out).
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
      // Group is already gone (leader exited, no other members).
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
