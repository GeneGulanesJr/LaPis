const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net'),
  { spawn } = require('node:child_process'),
  dispatchClient = require('../../src/claude-code/dispatch-client'),
  daemon = require('../../src/claude-code/daemon'),
  { createHttpServer } = require('../../src/http/server');

// A real LaPis HTTP server on a random port; its /health reports this process's pid.
async function listenHealthServer() {
  const server = createHttpServer({
    repositories: {},
    sqlJson: () => [],
    sqlRun: () => {},
    getDb: () => ({ prepare: () => ({ get: () => ({ 1: 1 }) }) }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

// A port that was free a moment ago, so nothing answers on it.
async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

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

  test('does not re-run the command directly when the daemon times out (#392)', async () => {
    const fetch = async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      directSpy = vi.fn(async () => ({ via: 'direct' }));

    await expect(
      dispatchClient.dispatch(
        'save',
        { title: 'x' },
        { resolveDaemonUrl: () => 'http://127.0.0.1:9100', fetch, directDispatch: directSpy },
      ),
    ).rejects.toThrow('timeout');
    expect(directSpy).not.toHaveBeenCalled();
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

  test('resolveDaemonUrl prefers LAPIS_DAEMON_URL', async () => {
    process.env.LAPIS_DAEMON_URL = 'http://127.0.0.1:9200/';
    daemon.writeLockfile({ pid: process.pid, port: 9100, host: '127.0.0.1' }, lockfilePath);
    expect(await daemon.resolveDaemonUrl({ lockfilePath })).toBe('http://127.0.0.1:9200');
  });

  test('resolveDaemonUrl reads a lockfile whose pid is the server answering /health', async () => {
    const server = await listenHealthServer();
    try {
      const { port } = server.address();
      daemon.writeLockfile({ pid: process.pid, port, host: '127.0.0.1' }, lockfilePath);
      expect(await daemon.resolveDaemonUrl({ lockfilePath })).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('resolveDaemonUrl returns null when lockfile pid is stale', async () => {
    daemon.writeLockfile({ pid: 999999999, port: 9100, host: '127.0.0.1' }, lockfilePath);
    expect(await daemon.resolveDaemonUrl({ lockfilePath })).toBeNull();
  });

  test('resolveDaemonUrl returns null when the live pid is not the server on the lockfile port', async () => {
    // Pid reuse after a crash/reboot: the pid is alive but nothing LaPis answers there.
    daemon.writeLockfile({ pid: process.pid, port: await closedPort(), host: '127.0.0.1' }, lockfilePath);
    expect(await daemon.resolveDaemonUrl({ lockfilePath })).toBeNull();
  });

  test('runStop never signals a live pid that is not the daemon on the lockfile port', async () => {
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      daemon.writeLockfile({ pid: bystander.pid, port: await closedPort(), host: '127.0.0.1' }, lockfilePath);
      await daemon.runStop([], { lockfilePath, log: () => {}, graceMs: 200 });
      expect(fs.existsSync(lockfilePath)).toBe(false);
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      expect(daemon.isProcessAlive(bystander.pid)).toBe(true);
    } finally {
      bystander.kill();
    }
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
        probeDaemonPid: async () => process.pid,
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
        probeDaemonPid: async () => process.pid,
      });
    expect(result.alreadyRunning).toBe(true);
    expect(result.mismatch).toBeUndefined();
    expect(lines.join('\n')).not.toContain('was requested');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('daemon pid safety', () => {
  test('detached runStart records the pid /health reports, not the (dead) child pid', async () => {
    // Another LaPis server already holds the port: our child dies on EADDRINUSE
    // And health is answered by that server, so adopt its pid.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-daemon-adopt-')),
      lockfilePath = path.join(tmpDir, 'daemon.json'),
      server = await listenHealthServer(),
      { port } = server.address();
    try {
      const result = await daemon.runStart(['--detached', '--port', String(port)], {
        lockfilePath,
        log: () => {},
        spawnDetachedServe: () => ({ pid: 999999999 }),
        stopProcess: async () => false,
      });
      expect(result.pid).toBe(process.pid);
      expect(daemon.readLockfile(lockfilePath).pid).toBe(process.pid);
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('daemon dispatch sends the configured API key', async () => {
    const prev = process.env.LAPIS_HTTP_API_KEY;
    process.env.LAPIS_HTTP_API_KEY = 'k-123';
    try {
      let headers;
      await dispatchClient.dispatchViaDaemon(
        'http://127.0.0.1:1',
        'search',
        {},
        {
          fetch: async (_url, init) => {
            headers = init.headers;
            return { ok: true, json: async () => ({}) };
          },
        },
      );
      expect(headers['x-api-key']).toBe('k-123');
    } finally {
      if (prev === undefined) {
        delete process.env.LAPIS_HTTP_API_KEY;
      } else {
        process.env.LAPIS_HTTP_API_KEY = prev;
      }
    }
  });
});
