// Unit tests for src/http/handlers/health.js
// The handler must actually ping the DB rather than reporting a constant.
const { healthCheck } = require('../src/http/handlers/health');

// Minimal fake response that captures the JSON body written by jsonOk.
function fakeRes() {
  const chunks = [];
  return {
    writeHead() {},
    end(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    },
  };
}

function invoke(deps) {
  const res = fakeRes();
  const handler = healthCheck(deps);
  return handler({}, res, {}).then(() => res.body);
}

describe('healthCheck', () => {
  it('reports ok + db:true when SELECT 1 succeeds', async () => {
    const db = {
      prepare() {
        return { get: () => ({ '?': 1, 1: 1 }) };
      },
    };
    const body = await invoke({ getDb: () => db });
    expect(body.status).toBe('ok');
    expect(body.db).toBe(true);
  });

  it('reports degraded + db:false when getDb throws', async () => {
    const body = await invoke({ getDb: () => { throw new Error('locked'); } });
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
  });

  it('reports degraded + db:false when the query throws', async () => {
    const db = {
      prepare() {
        throw new Error('database disk image is malformed');
      },
    };
    const body = await invoke({ getDb: () => db });
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
  });
});
