// Regression tests for review batch 8: #288 (HTTP mutations report missing
// ids / invalid statuses instead of blind 200s; code-index endpoints map
// errors to real statuses), #303 (postinstall atomic, version-checked
// patching), #304 (minors: memory-route limit/filters, harvest regex,
// NaN args, streaming timeout escalation). Isolated temp DB.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-batch8-'));

const dbModule = require('../db');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe('#288 aurex mutations report existence', () => {
  it('updateMissionStatus returns the row for a real mission and [] for a missing one', () => {
    dbModule.ensureDb();
    dbModule.sqlRun("INSERT INTO missions (id, description, status) VALUES ('m-b8', 'desc', 'planning')");

    const { createAurexRepository } = require('../src/platform/storage/repositories/aurex'),
      repo = createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun }),
      hit = repo.updateMissionStatus('m-b8', 'running'),
      miss = repo.updateMissionStatus('m-nope', 'running');

    expect(hit).toHaveLength(1);
    expect(hit[0].status).toBe('running');
    expect(miss).toHaveLength(0);
    expect(repo.incrementRetry('m-nope')).toBeNull();
  });
});

describe('#288 handlers return 400/404 instead of blind success', () => {
  function makeRepo(overrides = {}) {
    return {
      updateMissionStatus: () => [],
      updateMilestoneStatus: () => [],
      updateWorkingUnitStatus: () => [],
      classifyVerdict: () => [],
      transitionBroadcast: () => [],
      transitionFinding: () => [],
      incrementRetry: () => null,
      logRescope: () => false,
      ...overrides,
    };
  }

  async function call(handler, ctx) {
    const res = mockRes();
    await handler({}, res, ctx);
    return res;
  }

  it('updateMissionStatus: missing id -> 404, missing status -> 400, hit -> 200', async () => {
    const { updateMissionStatus } = require('../src/http/handlers/missions');
    const miss = await call(updateMissionStatus(makeRepo()), { params: { id: 'm-x' }, body: { status: 'running' } });
    expect(miss.statusCode).toBe(404);

    const invalid = await call(updateMissionStatus(makeRepo({ updateMissionStatus: () => [{ id: 'm' }] })), {
      params: { id: 'm-x' },
      body: {},
    });
    expect(invalid.statusCode).toBe(400);

    const hit = await call(
      updateMissionStatus(makeRepo({ updateMissionStatus: () => [{ id: 'm-x', status: 'running' }] })),
      {
        params: { id: 'm-x' },
        body: { status: 'running' },
      },
    );
    expect(hit.statusCode).toBe(200);
  });

  it('updateMilestoneStatus / updateWorkingUnitStatus / classifyVerdict validate and 404', async () => {
    const { updateMilestoneStatus } = require('../src/http/handlers/milestones'),
      { updateWorkingUnitStatus } = require('../src/http/handlers/units'),
      { classifyVerdict } = require('../src/http/handlers/verdicts');

    const ms = await call(updateMilestoneStatus(makeRepo()), { params: { id: 'ms-x' }, body: { status: 'done' } });
    expect(ms.statusCode).toBe(404);

    const wu = await call(updateWorkingUnitStatus(makeRepo()), { params: { id: 'wu-x' }, body: {} });
    expect(wu.statusCode).toBe(400);

    const vv = await call(classifyVerdict(makeRepo()), { params: { id: 'vv-x' }, body: {} });
    expect(vv.statusCode).toBe(400);
  });

  it('transitionBroadcast/transitionFinding never fabricate a success body', async () => {
    const { transitionBroadcast } = require('../src/http/handlers/broadcasts'),
      { transitionFinding } = require('../src/http/handlers/findings'),
      b = await call(transitionBroadcast(makeRepo()), { params: { id: 'nope' }, body: { newStatus: 'resolved' } }),
      f = await call(transitionFinding(makeRepo()), { params: { id: 'nope' }, body: { newStatus: 'verified' } });
    expect(b.statusCode).toBe(404);
    expect(b.body).not.toContain('"id":"nope"');
    expect(f.statusCode).toBe(404);
  });

  it('incrementRetry/logRescope 404 on a missing milestone', async () => {
    const { incrementRetry, logRescope } = require('../src/http/handlers/retry'),
      r = await call(incrementRetry(makeRepo()), { params: { milestoneId: 'ms-x' }, body: {} }),
      l = await call(logRescope(makeRepo()), { params: { milestoneId: 'ms-x' }, body: {} });
    expect(r.statusCode).toBe(404);
    expect(l.statusCode).toBe(404);
  });

  it('code-index endpoints map {error} results to non-200 statuses', () => {
    const src = fs.readFileSync('src/http/handlers/code-index.js', 'utf8');
    expect(src).toContain('function sendIndexResult');
    expect(src.match(/return sendIndexResult\(res, result\)/g)).toHaveLength(3);
    expect(src).toMatch(/not found\/i/);
  });
});

describe('#303 postinstall patches atomically and only vulnerable versions', () => {
  it('patches via staged rename, version-gates, and logs failures', () => {
    const src = fs.readFileSync('postinstall.js', 'utf8');
    expect(src).toContain('VULNERABLE_VERSIONS');
    expect(src).toMatch(/stagedDir/);
    expect(src).toMatch(/renameSync\(stagedDir, dir\)/);
    expect(src).toMatch(/failed to patch nested/);
    // The old rm-then-copy-then-swallow must be gone.
    expect(src).not.toMatch(/rmSync\(dir, \{ recursive: true, force: true \}\);\n\s*fs\.cpSync\(safeSrc, dir/);
  });
});

describe('#304 minors', () => {
  it('memory route clamps non-numeric limits and forwards filters', async () => {
    const { searchMemory } = require('../src/http/handlers/memory'),
      captured = [],
      deps = {
        sqlJson: (sql, params) => {
          captured.push({ sql, params });
          return [];
        },
        sqlRun: () => {},
      };

    const res = mockRes();
    await searchMemory(deps)({}, res, { body: { query: 'x', limit: 'abc' } });
    expect(res.statusCode).toBe(200);
    // search() fetches a multiple of the requested limit internally; what
    // matters is that the bind is a real number, not the NaN that used to
    // crash the query (#304).
    const limitBind = Number(captured[0].params[captured[0].params.length - 1]);
    expect(Number.isFinite(limitBind)).toBe(true);
    expect(limitBind).toBeGreaterThan(0);

    const res2 = mockRes();
    await searchMemory(deps)({}, res2, { body: { query: 'x', limit: 250, project: 'demo', type: 'decision' } });
    const clamped = Number(captured[1].params[captured[1].params.length - 1]);
    expect(Number.isFinite(clamped)).toBe(true);
    expect(clamped).toBeLessThan(2000); // a 250-limit is capped, not amplified 8x
    const scopedSql = captured[1].sql;
    expect(scopedSql).toContain('project');
    expect(scopedSql).toContain('type');
  });

  it('harvest regex alternation is longest-first with a boundary', () => {
    const src = fs.readFileSync('extensions/memory-layer/hooks/tool-guardrails.ts', 'utf8');
    expect(src).toMatch(/\.\(tsx\|jsx\|mts\|cts\|mjs\|cjs\|ts\|js\|py\|go\|rs\)\\b\/g/);
    // Behavior: the same shape the source uses now.
    const matches = 'src/Widget.tsx test/foo.jsx'.match(/[\w/.-]+\.(tsx|jsx|mts|cts|mjs|cjs|ts|js|py|go|rs)\b/g);
    expect(matches).toEqual(['src/Widget.tsx', 'test/foo.jsx']);
  });

  it('cleanup-sessions rejects a non-numeric --keep-last instead of crashing', () => {
    const { execFileSync } = require('node:child_process');
    // parseArgs slices argv[3+], so the script needs a leading filler token
    // for --keep-last to be seen.
    let threw = false;
    try {
      execFileSync('node', ['scripts/cleanup-sessions.js', 'run', '--keep-last', 'abc', '--json'], {
        encoding: 'utf8',
      });
    } catch (e) {
      threw = true;
      expect(String(e.stderr)).toContain('non-negative integer');
      expect(e.status).toBe(1);
    }
    expect(threw).toBe(true);
  });

  it('serve rejects an invalid port instead of crashing in listen', () => {
    const { execFileSync } = require('node:child_process');
    let threw = false;
    try {
      execFileSync('node', ['cli.js', 'serve', '--port', 'not-a-port'], { encoding: 'utf8', timeout: 15000 });
    } catch (e) {
      threw = true;
      expect(String(e.stderr) + String(e.stdout)).toContain('between 1 and 65535');
    }
    expect(threw).toBe(true);
  });

  it('memStreaming escalates to SIGKILL and does not double-run after a timeout', () => {
    const src = fs.readFileSync('extensions/memory-layer/host/memory-client.ts', 'utf8');
    expect(src).toMatch(/killTimer/);
    expect(src).toMatch(/child\.kill\('SIGKILL'\)/);
    expect(src).toMatch(/timedOut = true;/);
    expect(src).toMatch(/if \(timedOut\) \{[\s\S]*?not retrying/);
  });
});
