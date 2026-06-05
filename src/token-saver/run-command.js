const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BUFFER_CHARS = 2_000_000;

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
    } = options;

    const isWindows = process.platform === 'win32';
    let child;

    if (isWindows) {
      child = spawn('cmd', ['/c', ...commandArgs], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      const escaped = commandArgs.map(shellEscape).join(' ');
      child = spawn('/bin/sh', ['-c', escaped], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let killed = false;
    let timer = null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length >= maxBufferChars) {
        truncated = true;
        stdout = stdout.slice(0, maxBufferChars);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length >= maxBufferChars) {
        truncated = true;
        stderr = stderr.slice(0, maxBufferChars);
      }
    });

    timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
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
