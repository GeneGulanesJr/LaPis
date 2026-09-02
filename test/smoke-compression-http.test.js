// HTTP smoke test for the new mission-state compression endpoint
const http = require('http'),
  { createDb, resetDb, sqlJson, sqlRun } = require('../db'),
  { createAurexRepository } = require('../src/platform/storage/repositories/aurex');

describe('POST /missions/:id/compression (HTTP)', () => {
  let server, baseUrl;

  beforeAll(async () => {
    resetDb();
    createDb({ db_path: ':memory:' });
    // Seed a mission and a cost entry so the handler has something to compress
    sqlRun(`INSERT INTO missions (id, description, status, config_json, created_at) VALUES (?, ?, ?, ?, ?)`, [
      'm-smoke-1',
      'smoke test mission',
      'running',
      '{}',
      new Date().toISOString(),
    ]);
    sqlRun(
      `INSERT INTO cost_entries (id, mission_id, agent_session_id, model, prompt_tokens, completion_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['c-1', 'm-smoke-1', 's-1', 'test-model', 100, 50, 0.01],
    );

    const { createHttpServer } = require('../src/http/server');
    server = createHttpServer({
      repositories: { aurex: createAurexRepository({ sqlJson, sqlRun }) },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl),
        opts = {
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: { 'Content-Type': 'application/json' },
        },
        req = http.request(opts, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
            } catch (e) {
              resolve({ status: res.statusCode, body: data });
            }
          });
        });
      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  it('returns a structured CompressionResult for a mission with cost entries', async () => {
    const res = await request('POST', '/missions/m-smoke-1/compression', { trigger: 'post_milestone' });
    expect(res.status).toBe(200);
    expect(typeof res.body.summary).toBe('string');
    expect(typeof res.body.tokensSaved).toBe('number');
    expect(res.body.tokensSaved).toBeGreaterThanOrEqual(0);
    // Error is optional; if present, must be a string
    if (res.body.error !== undefined) {
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('returns a friendly empty-state summary for a mission with no state', async () => {
    sqlRun(`INSERT INTO missions (id, description, status, config_json, created_at) VALUES (?, ?, ?, ?, ?)`, [
      'm-smoke-empty',
      'empty mission',
      'running',
      '{}',
      new Date().toISOString(),
    ]);
    const res = await request('POST', '/missions/m-smoke-empty/compression', { trigger: 'manual' });
    expect(res.status).toBe(200);
    expect(typeof res.body.summary).toBe('string');
    expect(res.body.tokensSaved).toBe(0);
  });

  it('persists the compression run to mission_compression_log', async () => {
    const before = sqlJson('SELECT COUNT(*) AS c FROM mission_compression_log WHERE mission_id = ?', ['m-smoke-1']);
    await request('POST', '/missions/m-smoke-1/compression', { trigger: 'manual' });
    {
      const after = sqlJson('SELECT COUNT(*) AS c FROM mission_compression_log WHERE mission_id = ?', ['m-smoke-1']);
      expect(after[0].c).toBe(before[0].c + 1);
    }
  });
});
