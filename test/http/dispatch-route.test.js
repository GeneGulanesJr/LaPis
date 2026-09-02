const http = require('node:http'), { createDb, resetDb } = require('../../db'), { createHttpServer } = require('../../src/http/server'), { mergeDispatchArgs } = require('../../src/http/handlers/dispatch');




describe('POST /dispatch', () => {
  let server, baseUrl, dispatchCalls;

  beforeAll(async () => {
    resetDb();
    createDb({ db_path: ':memory:' });
    dispatchCalls = [];
    const mockDispatch = async (cmd, args) => {
      dispatchCalls.push({ cmd, args });
      if (cmd === 'unknown-cmd') {
        return { error: 'Unknown command: unknown-cmd' };
      }
      if (cmd === 'search') {
        return [{ id: 1, title: 'test memory' }];
      }
      return { ok: true, cmd, args };
    };
    server = createHttpServer({ repositories: { aurex: {} }, dispatch: mockDispatch });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetDb();
  });

  function request(body) {
    return new Promise((resolve, reject) => {
      const url = new URL('/dispatch', baseUrl),
        req = http.request(
          {
            method: 'POST',
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(data) });
              } catch {
                resolve({ status: res.statusCode, body: data });
              }
            });
          },
        );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  test('returns gateway result for a known cmd', async () => {
    const res = await request({ cmd: 'search', args: { query: 'hooks', limit: '5' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, title: 'test memory' }]);
    expect(dispatchCalls.at(-1)).toEqual({
      cmd: 'search',
      args: { query: 'hooks', limit: '5' },
    });
  });

  test('unknown cmd returns {error} envelope with 200', async () => {
    const res = await request({ cmd: 'unknown-cmd', args: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Unknown command: unknown-cmd' });
  });

  test('missing cmd returns 400', async () => {
    const res = await request({ args: { query: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  test('merges top-level project into args when args.project is absent', async () => {
    await request({ cmd: 'preflight', args: { query: 'auth' }, project: '/workspace/app' });
    expect(dispatchCalls.at(-1).args).toEqual({ query: 'auth', project: '/workspace/app' });
  });

  test('/dispatch is a distinct route from /memory/search', async () => {
    const dispatchRes = await request({ cmd: 'search', args: { query: 'route-check' } });
    expect(dispatchRes.status).toBe(200);

    const url = new URL('/memory/search', baseUrl),
      memoryRes = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            method: 'POST',
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { 'Content-Type': 'application/json' },
          },
          (msg) => resolve({ status: msg.statusCode, path: url.pathname }),
        );
        req.on('error', reject);
        req.write(JSON.stringify({ query: 'x' }));
        req.end();
      });
    expect(memoryRes.path).toBe('/memory/search');
    expect(memoryRes.path).not.toBe('/dispatch');
  });
});

describe('mergeDispatchArgs', () => {
  test('fills project from body when missing in args', () => {
    expect(mergeDispatchArgs({ args: { query: 'a' }, project: '/repo' })).toEqual({
      query: 'a',
      project: '/repo',
    });
  });

  test('does not overwrite explicit args.project', () => {
    expect(mergeDispatchArgs({ args: { project: '/explicit' }, project: '/body' })).toEqual({
      project: '/explicit',
    });
  });
});
