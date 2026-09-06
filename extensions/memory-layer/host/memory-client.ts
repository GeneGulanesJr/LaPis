import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
// oxlint-disable-next-line sort-imports
import { MEMORY_SCRIPT, MemResult, getTimeout } from '../state';

export type { MemResult };

let _inProcessDispatch: ((cmd: string, args: Record<string, string>) => Promise<MemResult | null>) | null = null,
  // In-process dispatch can fail for reasons unrelated to correctness (e.g. the
  // host runtime can't dlopen better-sqlite3). When that happens we fall back to
  // a child process — but we should only surface the failure ONCE per session,
  // not on every preflight/coding-context call. The real cause is reported via
  // openDb()'s improved error message (see db.js).
  _inProcessFailureReported = false;

const MAIN_THREAD_BLOCKING_COMMANDS = new Set([
  'index-repo',
  'reindex-repo',
  'index-docs',
  'reindex-docs',
  'save',
  'audit-diff',
  'dream',
  'log-negative-recall',
]);

async function getInProcessDispatch() {
  if (_inProcessDispatch) {
    return _inProcessDispatch;
  }
  try {
    // Resolve relative to THIS source file, not the compiled output.
    // Path: host/ → memory-layer/ → extensions/ → repo root → src/cli/gateway
    const gateway = require('../../../src/cli/gateway');
    if (gateway && typeof gateway.dispatch === 'function') {
      _inProcessDispatch = gateway.dispatch;
      return _inProcessDispatch;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    reportInProcessFailure('gateway', msg, 'load');
  }
  return null;
}

export async function mem(cmd: string, args: Record<string, string | number | boolean>): Promise<MemResult | null> {
  const dispatch = await getInProcessDispatch();
  if (dispatch && !MAIN_THREAD_BLOCKING_COMMANDS.has(cmd)) {
    try {
      const stringArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined && v !== null && v !== '') {
          stringArgs[k] = String(v);
        }
      }
      return await dispatch(cmd, stringArgs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reportInProcessFailure(cmd, msg, 'dispatch');
    }
  }
  return memViaChildProcess(cmd, args);
}

async function memViaChildProcess(
  cmd: string,
  args: Record<string, string | number | boolean>,
): Promise<MemResult | null> {
  const argList: string[] = [cmd];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') {
      // oxlint-disable-next-line no-continue
      continue;
    }
    argList.push(`--${k}`);
    argList.push(String(v));
  }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const timeout = getTimeout(cmd),
        child = execFile(
          process.execPath,
          [MEMORY_SCRIPT, ...argList],
          {
            encoding: 'utf8',
            timeout,
            maxBuffer: 10 * 1024 * 1024,
          },
          (err, stdout) => {
            if (err) {
              reject(err);
            } else {
              resolve(stdout.trim());
            }
          },
        );
      child.on('error', reject);
    });
    return out ? JSON.parse(out) : null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('timed out')) {
      console.error(`[memory-layer] ${cmd} timed out after ${getTimeout(cmd)}ms`);
    } else {
      console.error(`[memory-layer] ${cmd} failed:`, msg);
    }
    return null;
  }
}

export async function memCmd(cmd: string): Promise<MemResult | null> {
  // Same contract as mem(): blocking commands (dream, reindex, …) must always
  // take the child-process path — running them through the in-process gateway
  // freezes the UI thread for the whole multi-phase cycle.
  if (MAIN_THREAD_BLOCKING_COMMANDS.has(cmd)) {
    return memViaChildProcess(cmd, {});
  }
  const dispatch = await getInProcessDispatch();
  if (dispatch) {
    try {
      return await dispatch(cmd, {});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reportInProcessFailure(cmd, msg, 'dispatch');
    }
  }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const timeout = getTimeout(cmd);
      execFile(
        process.execPath,
        [MEMORY_SCRIPT, cmd],
        {
          encoding: 'utf8',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout.trim());
          }
        },
      );
    });
    return out ? JSON.parse(out) : null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[memory-layer] ${cmd} failed:`, msg);
    return null;
  }
}

type ProgressCallback = (msg: string) => void;

export async function memStreaming(
  cmd: string,
  args: Record<string, string | number | boolean>,
  onProgress?: ProgressCallback,
): Promise<MemResult | null> {
  const dispatch = await getInProcessDispatch();
  // Main-thread blocking commands must always use the child-process path
  // (spawn). The in-process dispatch runs better-sqlite3 synchronously on the
  // Main thread, which freezes Pi's TUI (spinner stops, stdin becomes
  // Unresponsive) when the DB is large. The child-process path is non-blocking
  // And streams progress via stderr.
  if (dispatch && !MAIN_THREAD_BLOCKING_COMMANDS.has(cmd)) {
    try {
      const stringArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined && v !== null && v !== '') {
          stringArgs[k] = String(v);
        }
      }
      if (onProgress) {
        onProgress(`Running ${cmd} in-process...`);
      }
      return await dispatch(cmd, stringArgs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reportInProcessFailure(cmd, msg, 'streaming');
    }
  }
  const argList: string[] = [cmd, '--progress'],
    timeout = (() => {
      for (const [k, v] of Object.entries(args)) {
        if (v === undefined || v === null || v === '') {
          // oxlint-disable-next-line no-continue
          continue;
        }
        argList.push(`--${k}`);
        argList.push(String(v));
      }

      return getTimeout(cmd);
    })();
  let timedOut = false;
  try {
    return await new Promise<MemResult | null>((resolve, reject) => {
      const child = spawn(process.execPath, [MEMORY_SCRIPT, ...argList], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '',
        timer: ReturnType<typeof setTimeout> | null = null,
        killTimer: ReturnType<typeof setTimeout> | null = null;
      {
        const resetTimer = () => {
          if (timer) {
            clearTimeout(timer);
          }
          timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            // SIGTERM cannot interrupt a child wedged in a synchronous
            // better-sqlite3 call — escalate to SIGKILL after a grace
            // window so it cannot keep holding the DB (#304).
            killTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {}
            }, 2000);
            reject(new Error(`${cmd} timed out after ${timeout}ms without output`));
          }, timeout + 5000);
        };
        resetTimer();

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          resetTimer();
        });

        if (onProgress) {
          const rl = createInterface({ input: child.stderr! });
          rl.on('line', (line: string) => {
            resetTimer();
            try {
              const parsed = JSON.parse(line);
              if (parsed.progress) {
                const phase = parsed.phase || '',
                  message = parsed.message || phase,
                  filesDone = parsed.files_done ?? '',
                  filesTotal = parsed.files_total ?? '',
                  symbols = parsed.symbols ?? '';
                let statusText = message;
                if (filesTotal) {
                  statusText = `${message} (${filesDone}/${filesTotal} files, ${symbols} symbols)`;
                }
                onProgress(statusText);
              }
            } catch {}
          });
        }

        child.on('close', (code) => {
          if (timer) {
            clearTimeout(timer);
          }
          if (killTimer) {
            clearTimeout(killTimer);
          }
          if (code !== 0 && !stdout.trim()) {
            reject(new Error(`${cmd} exited with code ${code}`));
            return;
          }
          try {
            const result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
            resolve(result);
          } catch {
            reject(new Error(`${cmd} returned invalid JSON`));
          }
        });

        child.on('error', (err) => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(err);
        });
      }
    });
  } catch {
    // A timed-out child was already killed — re-running the whole command
    // (for index-repo/reindex-repo: a second full index racing the first)
    // is worse than reporting the timeout (#304). The mem() fallback stays
    // for genuine spawn/startup failures.
    if (timedOut) {
      console.error(`[memory-layer] ${cmd} timed out and was terminated; not retrying`);
      return null;
    }
    return mem(cmd, args);
  }
}
function reportInProcessFailure(cmd: string, msg: string, kind: 'load' | 'dispatch' | 'streaming') {
  if (_inProcessFailureReported) {
    return;
  }
  _inProcessFailureReported = true;
  const verb = kind === 'load' ? 'load in-process gateway' : `run ${cmd} in-process`;
  console.error(`[memory-layer] failed to ${verb}, falling back to child process (this message will not repeat):`, msg);
}
