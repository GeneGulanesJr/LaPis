/**
 * Regression for #276: child-process fallback must launch LaPis with
 * `process.execPath` (the parent Node binary), not the PATH-resolved `node`.
 *
 * When Pi runs under one Node major but inherited PATH `node` is another,
 * child-only ops that load better-sqlite3 fail with ERR_DLOPEN_FAILED /
 * NODE_MODULE_VERSION mismatch. MAIN_THREAD_BLOCKING_COMMANDS (reindex-repo,
 * save, …) always take this path.
 *
 * The three call sites in extensions/memory-layer/host/memory-client.ts:
 *   mem()          → execFile (memViaChildProcess)
 *   memCmd()       → execFile
 *   memStreaming() → spawn
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mem, memStreaming } from '../extensions/memory-layer/host/memory-client.ts';

const execFileMock = vi.fn(),
  spawnMock = vi.fn(),
  MEMORY_CLIENT_SOURCE = resolve(import.meta.dirname, '../extensions/memory-layer/host/memory-client.ts');

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function mockExecFileSuccess(stdout = '{}') {
  execFileMock.mockImplementation((_file: string, _args: string[], options: unknown, cb?: Function) => {
    const callback = typeof options === 'function' ? options : cb;
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, stdout));
    }
    return new EventEmitter();
  });
}

function mockSpawnSuccess() {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0);
    });
    return child;
  });
}

function assertRuntimeBinary(file: unknown) {
  expect(file).toBe(process.execPath);
  expect(file).not.toBe('node');
  expect(isAbsolute(String(file))).toBe(true);
}

describe('memory-client child-process Node binary (#276)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
    mockExecFileSuccess();
    mockSpawnSuccess();
  });

  it('mem() via child process launches with process.execPath, not PATH node', async () => {
    // `save` is in MAIN_THREAD_BLOCKING_COMMANDS, so mem() always uses execFile.
    await mem('save', { text: 'x' });
    expect(execFileMock).toHaveBeenCalled();
    assertRuntimeBinary(execFileMock.mock.calls[0][0]);
  });

  it('memStreaming() via child process launches with process.execPath, not PATH node', async () => {
    // `reindex-repo` is in MAIN_THREAD_BLOCKING_COMMANDS, so spawn() is used.
    await memStreaming('reindex-repo', { repo: 'demo' });
    expect(spawnMock).toHaveBeenCalled();
    assertRuntimeBinary(spawnMock.mock.calls[0][0]);
  });

  it('all three child-launch sites use process.execPath, not PATH node', () => {
    const source = readFileSync(MEMORY_CLIENT_SOURCE, 'utf8'),
      memCmdSlice = source.slice(source.indexOf('export async function memCmd')),
      execFileSites = source.match(/execFile\(\s*process\.execPath/g) || [],
      spawnSites = source.match(/spawn\(\s*process\.execPath/g) || [];

    expect(source).not.toMatch(/execFile\(\s*['"]node['"]/);
    expect(source).not.toMatch(/spawn\(\s*['"]node['"]/);
    expect(execFileSites.length).toBe(2);
    expect(spawnSites.length).toBe(1);

    // MemCmd() is the second execFile site; it only runs when in-process
    // Dispatch fails, so assert it in source rather than depending on sqlite.
    expect(memCmdSlice).toMatch(/execFile\(\s*process\.execPath/);
    expect(memCmdSlice).not.toMatch(/execFile\(\s*['"]node['"]/);
  });
});
