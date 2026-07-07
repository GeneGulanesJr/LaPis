const { createHttpServer } = require('../src/http/server');
const http = require('http');

function request(server, { method = 'GET', path = '/health', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
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

describe('HTTP auth middleware', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it('allows unauthenticated health checks when api key is configured', async () => {
    server = createHttpServer({
      repositories: { aurex: {} },
      sqlJson: () => [],
      sqlRun: () => {},
      apiKey: 'test-key',
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await request(server, { path: '/health' });
    expect(res.status).toBe(200);
  });

  it('rejects protected routes without api key', async () => {
    server = createHttpServer({
      repositories: { aurex: {} },
      sqlJson: () => [],
      sqlRun: () => {},
      apiKey: 'test-key',
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await request(server, { method: 'POST', path: '/dispatch' });
    expect(res.status).toBe(401);
  });

  it('accepts x-api-key header', async () => {
    server = createHttpServer({
      repositories: { aurex: {} },
      sqlJson: () => [],
      sqlRun: () => {},
      apiKey: 'test-key',
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await request(server, {
      method: 'POST',
      path: '/dispatch',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
    });
    expect(res.status).not.toBe(401);
  });
});

describe('HTTP serve host policy', () => {
  it('refuses 0.0.0.0 without api key', async () => {
    const { assertServeHostPolicy } = require('../src/http/auth');
    expect(() => assertServeHostPolicy('0.0.0.0', null)).toThrow(/API key/);
  });
});
