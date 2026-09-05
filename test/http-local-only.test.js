// Regression tests for issue #285: the default (no API key) HTTP server
// accepted any Host header and any Origin, so a web page the developer
// visits could drive the API with a no-cors fetch, and DNS rebinding could
// make responses readable. Without a key the server is now loopback-only:
// non-loopback Host headers and cross-origin Origins are refused, and
// non-loopback binds are refused at startup.
const { createHttpServer } = require('../src/http/server'),
  http = require('http');

function request(server, { method = 'GET', path = '/health', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address(),
      req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path,
          method,
          headers,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
    req.on('error', reject);
    req.end();
  });
}

describe('local-only enforcement without an API key (#285)', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  function startNoKeyServer() {
    server = createHttpServer({
      repositories: { aurex: {} },
      sqlJson: () => [],
      sqlRun: () => {},
      apiKey: null,
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }

  it('serves loopback-addressed requests without a key', async () => {
    await startNoKeyServer();
    const res = await request(server, { path: '/health' });
    expect(res.status).toBe(200);
  });

  it('refuses a non-loopback Host header (DNS-rebinding shape)', async () => {
    await startNoKeyServer();
    const res = await request(server, { path: '/health', headers: { host: 'evil.example' } });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Local-only');
  });

  it('refuses cross-origin Origin headers (browser drive-by shape)', async () => {
    await startNoKeyServer();
    const res = await request(server, {
      method: 'POST',
      path: '/dispatch',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('cross-origin');
  });

  it('allows same-machine Origins (loopback dev servers)', async () => {
    await startNoKeyServer();
    const res = await request(server, {
      path: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
  });

  it('a configured API key supersedes the local-only checks', async () => {
    server = createHttpServer({
      repositories: { aurex: {} },
      sqlJson: () => [],
      sqlRun: () => {},
      apiKey: 'test-key',
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await request(server, {
      path: '/health',
      headers: { host: 'evil.example', 'x-api-key': 'test-key' },
    });
    expect(res.status).toBe(200);
  });
});

describe('serve host policy covers every non-loopback address (#285)', () => {
  const { assertServeHostPolicy, isLoopbackHost } = require('../src/http/auth');

  it('refuses LAN addresses without an API key, not just 0.0.0.0', () => {
    expect(() => assertServeHostPolicy('192.168.1.5', null)).toThrow(/API key/);
    expect(() => assertServeHostPolicy('10.0.0.1', null)).toThrow(/API key/);
  });

  it('still allows loopback binds without an API key', () => {
    expect(() => assertServeHostPolicy('127.0.0.1', null)).not.toThrow();
    expect(() => assertServeHostPolicy('localhost', null)).not.toThrow();
    expect(() => assertServeHostPolicy('::1', null)).not.toThrow();
  });

  it('allows any bind when an API key is configured', () => {
    expect(() => assertServeHostPolicy('192.168.1.5', 'test-key')).not.toThrow();
    expect(() => assertServeHostPolicy('0.0.0.0', 'test-key')).not.toThrow();
  });

  it('classifies loopback hostnames', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.127.0.3')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('api.localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('evil.example')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});
