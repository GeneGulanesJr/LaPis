const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), dispatchClient = require('../../src/claude-code/dispatch-client'), daemon = require('../../src/claude-code/daemon');






describe('dispatch-client', () => {
  test('direct mode returns gateway-shaped results when no daemon is configured', async () => {
    const directSpy = vi.fn(async () => ({ via: 'direct', items: [] })),
      result = await dispatchClient.dispatch(
        'search',
        { query: 'daemon', limit: '3' },
        { resolveDaemonUrl: () => null, directDispatch: directSpy },
      );

    expect(result).toEqual({ via: 'direct', items: [] });
    expect(directSpy).toHaveBeenCalledWith('search', { query: 'daemon', limit: '3' });
  });

  test('daemon mode POSTs to /dispatch and parses JSON', async () => {
    const calls = [],
      fetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          async json() {
            return { route: 'daemon', echoed: this._payload };
          },
          _payload: JSON.parse(init.body),
        };
      },
      result = await dispatchClient.dispatchViaDaemon(
        'http://127.0.0.1:9100',
        'preflight',
        { query: 'auth', project: '/repo' },
        { fetch },
      );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:9100/dispatch');
    expect(calls[0].body).toEqual({
      cmd: 'preflight',
      args: { query: 'auth', project: '/repo' },
    });
    expect(result.route).toBe('daemon');
  });

  test('dispatch uses daemon when resolveDaemonUrl returns a base URL', async () => {
    const fetch = async (_url, init) => ({
        ok: true,
        json: async () => ({ via: 'daemon', body: JSON.parse(init.body) }),
      }),
      result = await dispatchClient.dispatch(
        'context',
        { project: '/workspace' },
        {
          resolveDaemonUrl: () => 'http://127.0.0.1:9100',
          fetch,
        },
      );
    expect(result.via).toBe('daemon');
    expect(result.body.cmd).toBe('context');
  });

  test('falls back to direct mode when daemon POST fails', async () => {
    const fetch = async () => {
        throw new Error('connection refused');
      },
      directSpy = vi.fn(async () => ({ via: 'direct' })),
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      result = await dispatchClient.dispatch(
        'search',
        { query: 'x' },
        {
          resolveDaemonUrl: () => 'http://127.0.0.1:9100',
          fetch,
          directDispatch: directSpy,
        },
      );

    expect(result).toEqual({ via: 'direct' });
    expect(directSpy).toHaveBeenCalledWith('search', { query: 'x' });
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('falling back to direct mode'))).toBe(true);
    stderrSpy.mockRestore();
  });

  test('daemon and direct paths stringify args the same way', () => {
    const args = { query: 'hooks', limit: 5, empty: '', skip: null };
    expect(dispatchClient.stringifyArgs(args)).toEqual({ query: 'hooks', limit: '5' });
  });
});

describe('daemon lockfile resolution', () => {
  let tmpDir, lockfilePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-daemon-'));
    lockfilePath = path.join(tmpDir, 'daemon.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LAPIS_DAEMON_URL;
  });

  test('resolveDaemonUrl prefers LAPIS_DAEMON_URL', () => {
    process.env.LAPIS_DAEMON_URL = 'http://127.0.0.1:9200/';
    daemon.writeLockfile({ pid: process.pid, port: 9100, host: '127.0.0.1' }, lockfilePath);
    expect(daemon.resolveDaemonUrl({ lockfilePath })).toBe('http://127.0.0.1:9200');
  });

  test('resolveDaemonUrl reads live lockfile when env is unset', () => {
    daemon.writeLockfile({ pid: process.pid, port: 9100, host: '127.0.0.1' }, lockfilePath);
    expect(daemon.resolveDaemonUrl({ lockfilePath })).toBe('http://127.0.0.1:9100');
  });

  test('resolveDaemonUrl returns null when lockfile pid is stale', () => {
    daemon.writeLockfile({ pid: 999999999, port: 9100, host: '127.0.0.1' }, lockfilePath);
    expect(daemon.resolveDaemonUrl({ lockfilePath })).toBeNull();
  });

  test('runStop removes lockfile', async () => {
    daemon.writeLockfile({ pid: 999999999, port: 9100, host: '127.0.0.1' }, lockfilePath);
    const lines = [];
    await daemon.runStop([], { lockfilePath, log: (l) => lines.push(l) });
    expect(fs.existsSync(lockfilePath)).toBe(false);
    expect(lines.some((l) => l.includes('stopped'))).toBe(true);
  });
});

describe('daemon start/stop flags', () => {
  test('parseStartFlags defaults and validates port', () => {
    expect(daemon.parseStartFlags([])).toEqual({
      port: 9100,
      host: '127.0.0.1',
      detached: false,
    });
    expect(daemon.parseStartFlags(['--detached', '--port', '9200', '--host', '0.0.0.0'])).toEqual({
      port: 9200,
      host: '0.0.0.0',
      detached: true,
    });
    expect(() => daemon.parseStartFlags(['--port', '0'])).toThrow(/port/);
  });

  test('runStart kills spawned child when health check fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-daemon-start-')),
      lockfilePath = path.join(tmpDir, 'daemon.json'),
      stopSpy = vi.fn().mockResolvedValue(true),
      child = { pid: 4242 };

    await expect(
      daemon.runStart(['--detached'], {
        lockfilePath,
        log: () => {},
        spawnDetachedServe: () => child,
        waitForHealth: async () => {
          throw new Error('health timeout');
        },
        stopProcess: stopSpy,
      }),
    ).rejects.toThrow('health timeout');

    expect(stopSpy).toHaveBeenCalledWith(4242, expect.objectContaining({ lockfilePath }));
    expect(fs.existsSync(lockfilePath)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runStart warns and keeps the existing daemon when a different port is requested', async () => {
    // #232: re-install with a different --daemon-port must not silently drop the
    // Flag nor relocate the running daemon; it warns loudly and keeps the old one.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-daemon-port-')),
      lockfilePath = path.join(tmpDir, 'daemon.json');
    daemon.writeLockfile({ pid: process.pid, port: 9100, host: '127.0.0.1' }, lockfilePath);
    const lines = [],
      result = await daemon.runStart(['--detached', '--port', '9300'], {
        lockfilePath,
        log: (l) => lines.push(l),
      });
    expect(result.alreadyRunning).toBe(true);
    expect(result.port).toBe(9100);
    expect(result.requestedPort).toBe(9300);
    expect(result.mismatch.portMismatch).toBe(true);
    expect(lines.join('\n')).toContain('9300 was requested');
    // Lockfile unchanged — the running daemon is preserved.
    expect(daemon.readLockfile(lockfilePath).port).toBe(9100);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runStart silently no-ops when the same port is requested', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-daemon-same-')),
      lockfilePath = path.join(tmpDir, 'daemon.json');
    daemon.writeLockfile({ pid: process.pid, port: 9100, host: '127.0.0.1' }, lockfilePath);
    const lines = [],
      result = await daemon.runStart(['--port', '9100'], {
        lockfilePath,
        log: (l) => lines.push(l),
      });
    expect(result.alreadyRunning).toBe(true);
    expect(result.mismatch).toBeUndefined();
    expect(lines.join('\n')).not.toContain('was requested');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
