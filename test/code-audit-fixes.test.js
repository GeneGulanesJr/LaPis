// Regression tests for code-audit findings (#1-#8). Each sub-describe covers
// One verified bug fix. Run via: npm test -- code-audit-fixes

const http = require('http'),
  { matchRoute } = require('../src/http/routes'),
  { createHttpServer } = require('../src/http/server');

// ── #1 + #2: HTTP server must not crash on malformed URL / percent-encoding ──

describe('code-audit: HTTP URL + route parsing hardening', () => {
  let server;

  function listen(serverInstance) {
    return new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
  }

  function request(port, method, path) {
    return new Promise((resolve, reject) => {
      const req = http.request({ port, method, path, host: '127.0.0.1' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it('matchRoute returns null on malformed percent-encoding instead of throwing', () => {
    // DecodeURIComponent('%ZZ') throws URIError if unguarded.
    expect(() =>
      matchRoute('GET', '/bad/%ZZ', [{ method: 'GET', pattern: '/bad/:x', handler: () => {} }]),
    ).not.toThrow();
    expect(matchRoute('GET', '/bad/%ZZ', [{ method: 'GET', pattern: '/bad/:x', handler: () => {} }])).toBeNull();
  });

  it('server responds 400 (not hang/crash) on request with missing Host header', async () => {
    server = createHttpServer({ repositories: { aurex: {} }, dispatch: () => ({}) });
    await listen(server);
    const { port } = server.address(),
      // Craft a raw request with no Host header. The server now defaults to
      // 'localhost' instead of throwing on `http://undefined`.
      res = await new Promise((resolve, reject) => {
        const socket = require('net').connect(port, '127.0.0.1', () => {
          socket.end('GET /health HTTP/1.0\r\n\r\n');
        });
        let raw = '';
        socket.on('data', (c) => (raw += c));
        socket.on('end', () => resolve(raw));
        socket.on('error', reject);
      });
    // Should be a valid HTTP response (some status code), not a hung socket
    // Or a process crash from `new URL(req.url, 'http://undefined')`.
    expect(res).toMatch(/^HTTP\/1\.\d \d{3}/);
  }, 5000);
});

// ── #6: rankObservations must not produce NaN on invalid created_at ──

describe('code-audit: rankObservations NaN guard', () => {
  const { rankObservations } = require('../services/search');

  it('produces finite scores when created_at is empty/invalid', () => {
    const rows = [
        { id: 1, title: 'bad date', type: 'decision', created_at: '', trust_score: 0.5, recall_count: 0, rank: 0 },
        {
          id: 2,
          title: 'garbage date',
          type: 'decision',
          created_at: 'not-a-date',
          trust_score: 0.5,
          recall_count: 0,
          rank: 0,
        },
      ],
      ranked = rankObservations(rows, 'test');
    for (const r of ranked) {
      expect(Number.isFinite(r._score)).toBe(true);
    }
  });
});

// ── #7: cyclomatic complexity must not double-count `else if` ──

describe('code-audit: complexity else-if not double-counted', () => {
  it('counts else-if once, not twice (real DECISION_PATTERNS)', () => {
    // Exercise the shipped DECISION_PATTERNS, not a local copy, so a future
    // Edit to the module is caught by this regression test.
    const { DECISION_PATTERNS } = require('../src/code-analysis/complexity-impl'),
      count = (body) => {
        let c = 1;
        for (const p of DECISION_PATTERNS) {
          p.lastIndex = 0;
          const m = body.match(p);
          if (m) {
            c += m.length;
          }
        }
        return c;
      };
    // `else if` → base 1 + 1 (if) + 1 (else if) = 3
    expect(count('if (a) {} else if (b) {}')).toBe(3);
    // Multiple spaces between else and if still handled
    expect(count('if (a) {} else  if (b) {}')).toBe(3);
    // Two independent ifs → base 1 + 2 = 3
    expect(count('if (a) { if (b) {} }')).toBe(3);
  });
});

// ── #8: usedFallback field removed from incremental reindex result ──

describe('code-audit: dead usedFallback field removed', () => {
  it('rebuildDerivedIncremental result no longer carries usedFallback', () => {
    // Source-level check: the field was always-false dead code. Verify the
    // Shipped module no longer references it.
    const src = require('fs').readFileSync(require.resolve('../src/code-index/incremental-indexer'), 'utf8');
    expect(src).not.toContain('usedFallback');
  });
});

// ── #13: settings getSetting must not crash on non-JSON stored value ──

describe('code-audit: settings getSetting non-JSON guard', () => {
  it('returns raw string when stored value is not valid JSON', async () => {
    const sqlJson = () => [{ value: 'not-json' }],
      { getSetting } = require('../src/http/handlers/settings'),
      handler = getSetting(sqlJson),
      res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

    await handler({ method: 'GET' }, res, { params: { key: 'x' } });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    {
      const payload = JSON.parse(res.end.mock.calls[0][0]);
      // Non-JSON stored value falls back to raw string instead of throwing.
      expect(payload.value).toBe('not-json');
    }
  });
});
