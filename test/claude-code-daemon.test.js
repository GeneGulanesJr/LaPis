'use strict';

const path = require('node:path'),
  fs = require('node:fs'),
  os = require('node:os');

const { writeLockfile, readLockfile } = require('../src/claude-code/daemon');

function tempLockfilePath() {
  return path.join(
    os.tmpdir(),
    `lapis-daemon-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

describe('autoDaemonEnabled', () => {
  const ORIGINAL = process.env.LAPIS_HOOK_AUTODAEMON;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.LAPIS_HOOK_AUTODAEMON;
    } else {
      process.env.LAPIS_HOOK_AUTODAEMON = ORIGINAL;
    }
  });

  it('is disabled by default and for values other than 1/true', () => {
    delete process.env.LAPIS_HOOK_AUTODAEMON;
    const { autoDaemonEnabled } = require('../src/claude-code/daemon');
    expect(autoDaemonEnabled()).toBe(false);
    process.env.LAPIS_HOOK_AUTODAEMON = '0';
    expect(autoDaemonEnabled()).toBe(false);
    process.env.LAPIS_HOOK_AUTODAEMON = 'yes';
    expect(autoDaemonEnabled()).toBe(false);
  });

  it('is enabled for 1 and true', () => {
    const { autoDaemonEnabled } = require('../src/claude-code/daemon');
    process.env.LAPIS_HOOK_AUTODAEMON = '1';
    expect(autoDaemonEnabled()).toBe(true);
    process.env.LAPIS_HOOK_AUTODAEMON = 'true';
    expect(autoDaemonEnabled()).toBe(true);
  });
});

describe('ensureDaemonRunning', () => {
  const ORIGINAL = process.env.LAPIS_HOOK_AUTODAEMON;
  let lockfilePath;

  beforeEach(() => {
    vi.resetModules();
    lockfilePath = tempLockfilePath();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.LAPIS_HOOK_AUTODAEMON;
    } else {
      process.env.LAPIS_HOOK_AUTODAEMON = ORIGINAL;
    }
    if (fs.existsSync(lockfilePath)) {
      fs.unlinkSync(lockfilePath);
    }
  });

  it('returns null without starting anything when the opt-in env is unset', async () => {
    delete process.env.LAPIS_HOOK_AUTODAEMON;
    const { ensureDaemonRunning } = require('../src/claude-code/daemon');
    const startFn = vi.fn();
    const url = await ensureDaemonRunning({ lockfilePath, startFn });
    expect(url).toBeNull();
    expect(startFn).not.toHaveBeenCalled();
  });

  it('returns the existing lockfile URL without starting a daemon', async () => {
    process.env.LAPIS_HOOK_AUTODAEMON = '1';
    writeLockfile(
      { pid: process.pid, port: 9100, host: '127.0.0.1', startedAt: new Date().toISOString() },
      lockfilePath,
    );
    const { ensureDaemonRunning } = require('../src/claude-code/daemon');
    const startFn = vi.fn();
    const url = await ensureDaemonRunning({ lockfilePath, startFn });
    expect(url).toBe('http://127.0.0.1:9100');
    expect(startFn).not.toHaveBeenCalled();
  });

  it('starts a detached daemon once and resolves its URL from the lockfile', async () => {
    process.env.LAPIS_HOOK_AUTODAEMON = '1';
    const { ensureDaemonRunning } = require('../src/claude-code/daemon');
    const startFn = vi.fn(async () => {
      // runStart detached writes the lockfile after a successful health wait.
      writeLockfile(
        { pid: process.pid, port: 9100, host: '127.0.0.1', startedAt: new Date().toISOString() },
        lockfilePath,
      );
      return { pid: process.pid, port: 9100, host: '127.0.0.1' };
    });
    const url = await ensureDaemonRunning({ lockfilePath, startFn });
    expect(startFn).toHaveBeenCalledTimes(1);
    expect(startFn.mock.calls[0][0]).toEqual(['--detached']);
    expect(url).toBe('http://127.0.0.1:9100');
  });

  it('returns null (direct fallback) when the start attempt fails', async () => {
    process.env.LAPIS_HOOK_AUTODAEMON = '1';
    const { ensureDaemonRunning } = require('../src/claude-code/daemon');
    const startFn = vi.fn(async () => {
      throw new Error('Daemon did not become healthy');
    });
    const url = await ensureDaemonRunning({ lockfilePath, startFn });
    expect(url).toBeNull();
    expect(startFn).toHaveBeenCalledTimes(1);
  });
});

describe('runStart detached race guard', () => {
  let lockfilePath;

  beforeEach(() => {
    vi.resetModules();
    lockfilePath = tempLockfilePath();
  });

  afterEach(() => {
    if (fs.existsSync(lockfilePath)) {
      fs.unlinkSync(lockfilePath);
    }
  });

  it('keeps a concurrent winner lockfile instead of overwriting it with a dead pid', async () => {
    // The lockfile already names a live process (this test process) — another
    // racer bound the port first. Our spawned child then died on EADDRINUSE
    // while the health check was answered by the winner's server.
    const winnerInfo = { pid: process.pid, port: 9100, host: '127.0.0.1', startedAt: new Date().toISOString() };
    writeLockfile(winnerInfo, lockfilePath);
    const { runStart } = require('../src/claude-code/daemon');
    const deadChildPid = process.pid + 424242;
    const result = await runStart(['--detached'], {
      lockfilePath,
      log: () => {},
      spawnDetachedServe: vi.fn(() => ({ pid: deadChildPid, unref() {} })),
      waitForHealth: vi.fn(async () => true),
      stopProcess: vi.fn(async () => false),
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.pid).toBe(process.pid);
    // The winner's live-pid record must survive on disk.
    expect(readLockfile(lockfilePath).pid).toBe(process.pid);
  });

  it('writes its own child pid when no concurrent daemon owns the port', async () => {
    const { runStart } = require('../src/claude-code/daemon');
    const childPid = process.pid + 424243;
    const result = await runStart(['--detached'], {
      lockfilePath,
      log: () => {},
      spawnDetachedServe: vi.fn(() => ({ pid: childPid, unref() {} })),
      waitForHealth: vi.fn(async () => true),
      stopProcess: vi.fn(async () => false),
    });
    expect(result.alreadyRunning).toBeUndefined();
    expect(result.pid).toBe(childPid);
    expect(readLockfile(lockfilePath).pid).toBe(childPid);
  });
});
