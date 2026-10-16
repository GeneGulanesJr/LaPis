// Vitest globals enabled — no import
//
// Every judgment surface through its REAL judge builder, with only the network
// Mocked: a stubbed global fetch answers the Liquid Decisions API request, so
// The path surface → src/judgment/surface.js → createJudge() → decision adapter
// Runs for real.
//
// Why: four surfaces (recall, dedupe, trust, guard) and the Pi auto-save hook
// Built the createJudge() OBJECT and then called it as a function. Every live
// Call threw "judge is not a function" inside the surface's own try/catch and
// Fell back silently; the unit tests stayed green because they inject a judge
// Function (args._judge). Nothing here injects a judge.

const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { resetConfigCache } = require('../config'),
  { buildSurfaceJudge, surfaceEnabled } = require('../src/judgment/surface'),
  { decisionRerank, searchDecisionEnabled } = require('../src/memory-domain/search-decision'),
  { decisionVerifyDuplicates, dedupeDecisionEnabled } = require('../src/memory-domain/dedupe-decision'),
  {
    decisionInvalidationReview,
    maybeTrustDecisionReview,
    trustDecisionEnabled,
  } = require('../src/trust-sync/trust-decision'),
  { maybeClassifyCommand, guardDecisionEnabled } = require('../src/token-saver/classify-decision'),
  { buildAutosaveJudge } = require('../src/hooks-engine/autosave-judge'),
  { shouldAutoCaptureWithJudge } = require('../src/hooks-engine/pattern-matcher'),
  {
    dreamDecisionReview,
    maybeDreamDecisionReview,
    dreamDecisionEnabled,
  } = require('../src/memory-domain/dream-decision'),
  { contextDecisionEnabled } = require('../src/memory-domain/context-decision'),
  SURFACES = ['recall', 'dedupe', 'trust', 'guard', 'autosave', 'dream', 'context'],
  ENV_KEYS = [
    'LAPIS_JUDGE_PROVIDER',
    'LIQUID_API_KEY',
    'LAPIS_JUDGE_LOG',
    'LAPIS_JUDGE_LOCAL_ONLY',
    'LAPIS_JUDGE_SURFACE_TIMEOUT_MS',
    ...SURFACES.map((s) => `LAPIS_JUDGE_DISABLE_${s.toUpperCase()}`),
  ],
  ON = { LAPIS_JUDGE_PROVIDER: 'decision', LIQUID_API_KEY: 'k-test' },
  PLAIN_TEXT =
    'Ran the test suite, all 355 tests pass. Also fixed a typo in the README and updated the changelog date. Nothing decision-like here at all, just routine maintenance work and output.';

let saved, tmpDir, logFile;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-surfaces-wire-'));
  logFile = path.join(tmpDir, 'judgment.log');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
  resetConfigCache();
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setEnv(env) {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
  Object.assign(process.env, { LAPIS_JUDGE_LOG: logFile }, env);
  resetConfigCache();
}

/** The state entry a question is about: the first backticked key of its instructions that is in the state. */
function subjectOf(question, state) {
  const keys = [...String(question.instructions).matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]),
    key = keys.find((k) => k in state && !['query', 'incoming', 'changed_symbols', 'task'].includes(k));
  return key ? state[key] : undefined;
}

/**
 * Stub the Liquid wire. answer(question, subject, body) returns the wire answer
 * for one question ({noul} | {score, confidence} | {choice, confidence}).
 * Records every parsed request body.
 */
function stubLiquid(answer) {
  const bodies = [],
    fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, q]) => [id, answer(q, subjectOf(q, body.state), body)]),
      );
      return { ok: true, status: 200, json: async () => ({ answers }), text: async () => '' };
    });
  vi.stubGlobal('fetch', fetchImpl);
  return { fetchImpl, bodies };
}

function stubFailingWire(status = 503) {
  const fetchImpl = vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => 'upstream down',
  }));
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function logLines() {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('buildSurfaceJudge — the shared seam', () => {
  it('returns the judge FUNCTION, not the createJudge() object', () => {
    setEnv(ON);
    const judge = buildSurfaceJudge({});
    expect(typeof judge).toBe('function');
    expect(judge.probe).toBeUndefined();
  });

  it('passes an injected test judge through untouched', () => {
    const injected = vi.fn();
    expect(buildSurfaceJudge({ _judge: injected })).toBe(injected);
  });
});

describe('recall — memory search rerank through the real judge', () => {
  const rows = [
    { id: 11, title: 'Deploy on Fridays', snippet: 'release schedule' },
    { id: 12, title: 'SQLite WAL bound', snippet: 'journal_size_limit caps the WAL' },
    { id: 13, title: 'WAL checkpoint', snippet: 'readers hold WAL snapshots' },
  ];

  it('ONE request, each row under its own state key, graded and reordered; one log line without text', async () => {
    setEnv(ON);
    const { fetchImpl, bodies } = stubLiquid((q, row) => {
      const level = row && /WAL/.test(row.snippet) ? (row.id === 12 ? 2 : 1) : 0;
      return { score: level, confidence: 0.9 };
    });
    expect(searchDecisionEnabled()).toBe(true);
    const r = await decisionRerank(rows, 'sqlite wal size', {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.reranked).toBe(true);
    expect(r.unavailable).toBeUndefined();
    expect(r.rows.map((x) => x.id)).toEqual([12, 13, 11]);
    expect(r.rows[0].decision).toMatchObject({ level: 2, relevance: 'central' });
    expect(Object.keys(bodies[0].state).sort()).toEqual(['memory_0', 'memory_1', 'memory_2', 'query']);

    const [line] = logLines();
    expect(line).toMatchObject({ surface: 'recall', status: 'ok', n: 3, moved: true });
    expect(line.levels).toEqual([
      { id: 12, level: 2 },
      { id: 13, level: 1 },
      { id: 11, level: 0 },
    ]);
    const raw = fs.readFileSync(logFile, 'utf8');
    expect(raw).not.toMatch(/journal_size_limit|Deploy on Fridays|sqlite wal size/);
  });

  it('wire error → lexical order unchanged, exactly one attempt (no retries), logged unavailable', async () => {
    setEnv(ON);
    const fetchImpl = stubFailingWire(),
      r = await decisionRerank(rows, 'q', {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ rows, reranked: false, unavailable: true });
    expect(logLines()[0]).toMatchObject({ surface: 'recall', status: 'unavailable', n: 3 });
  });

  it('a hanging provider is cut at judgment.surface_timeout_ms and the order is unchanged', async () => {
    setEnv({ ...ON, LAPIS_JUDGE_SURFACE_TIMEOUT_MS: '60' });
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const t0 = Date.now(),
      r = await decisionRerank(rows, 'q', {});
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.reranked).toBe(false);
    expect(r.rows).toBe(rows);
  });
});

describe('dedupe — duplicate verification on save through the real judge', () => {
  it('ONE request; existing content looked up read-only; per-candidate keys; p attached', async () => {
    setEnv(ON);
    const { fetchImpl, bodies } = stubLiquid((q, existing) => ({ noul: /WAL/.test(existing.content) ? 0.92 : 0.04 })),
      deps = {
        sqlJson: vi.fn(() => [
          { id: 5, content: 'Bound the WAL with journal_size_limit' },
          { id: 6, content: 'Deploy on Fridays' },
        ]),
      };
    expect(dedupeDecisionEnabled()).toBe(true);
    const r = await decisionVerifyDuplicates(
      deps,
      [
        { id: 5, title: 'Cap the WAL' },
        { id: 6, title: 'Release day' },
      ],
      { incomingTitle: 'Cap the SQLite WAL', incomingContent: 'journal_size_limit = 256 MB' },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deps.sqlJson.mock.calls[0][0]).toMatch(/^SELECT id, content FROM observations WHERE id IN/);
    expect(r.unavailable).toBeUndefined();
    expect(r.verified.map((v) => [v.id, v.same])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(Object.keys(bodies[0].state).sort()).toEqual(['existing_0', 'existing_1', 'incoming']);
    expect(logLines()[0]).toMatchObject({ surface: 'dedupe', status: 'ok', n: 2, p: [{ id: 5, p: 0.92 }, { id: 6 }] });
    expect(fs.readFileSync(logFile, 'utf8')).not.toMatch(/journal_size_limit|Deploy/);
  });

  it('wire error → unavailable (the save result gets no decisionVerified), one attempt', async () => {
    setEnv(ON);
    const fetchImpl = stubFailingWire(),
      r = await decisionVerifyDuplicates({}, [{ id: 1, title: 'A' }], {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ verified: [], unavailable: true });
  });
});

describe('trust — invalidation review through the real judge', () => {
  it('ONE request, per-memory keys, verified p', async () => {
    setEnv(ON);
    const { fetchImpl, bodies } = stubLiquid((q, memory) => ({ noul: memory.id === 12 ? 0.8 : 0.1 })),
      r = await maybeTrustDecisionReview(
        [
          { memory_id: 12, symbol_id: 'a' },
          { memory_id: 13, symbol_id: 'b' },
        ],
        ['a', 'b'],
        null,
      );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.unavailable).toBeUndefined();
    expect(r.verified.map((v) => v.invalidated)).toEqual([true, false]);
    expect(Object.keys(bodies[0].state).sort()).toEqual(['changed_symbols', 'memory_0', 'memory_1']);
    expect(logLines()[0]).toMatchObject({ surface: 'trust', status: 'ok', n: 2 });
  });

  it('wire error → {verified: [], unavailable: true}, one attempt', async () => {
    setEnv(ON);
    const fetchImpl = stubFailingWire(),
      r = await decisionInvalidationReview([{ memory_id: 1, symbol_id: 'x' }], ['x'], {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.verified).toEqual([]);
    expect(r.unavailable).toBe(true);
  });
});

describe('guard — token-saver command classification through the real judge', () => {
  it('a command no regex matches: ONE request, confident pick used; the log holds no command text', async () => {
    setEnv(ON);
    const { fetchImpl } = stubLiquid(() => ({ choice: 'list', confidence: 0.9 })),
      // timeoutMs here is the COMMAND's timeout (executeAndCompress options) — never the judge cap.
      type = await maybeClassifyCommand(['du', '-sh', 'secret-dir'], { timeoutMs: 120000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(type).toBe('list');
    expect(logLines()[0]).toMatchObject({ surface: 'guard', status: 'ok', pick: 'list', confidence: 0.9, used: true });
    expect(fs.readFileSync(logFile, 'utf8')).not.toMatch(/secret-dir/);
  });

  it('a regex-matched command never reaches the wire', async () => {
    setEnv(ON);
    const { fetchImpl } = stubLiquid(() => ({ choice: 'list', confidence: 0.9 }));
    expect(await maybeClassifyCommand(['git', 'status'], {})).toBe('git-status');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wire error → the sync classification (generic), one attempt', async () => {
    setEnv(ON);
    const fetchImpl = stubFailingWire();
    expect(await maybeClassifyCommand(['du', '-sh', '.'], {})).toBe('generic');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('autosave — Pi passive capture through the real judge', () => {
  it('buildAutosaveJudge returns a FUNCTION that reaches the wire; a confident pick captures', async () => {
    setEnv(ON);
    const { fetchImpl } = stubLiquid(() => ({ choice: 'bugfix', confidence: 0.85 })),
      judge = buildAutosaveJudge();
    expect(typeof judge).toBe('function');
    const r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, { judge });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ match: true, source: 'judgment', pattern: { type: 'bugfix' } });
    expect(logLines()[0]).toMatchObject({ surface: 'autosave', status: 'ok', pick: 'bugfix', confidence: 0.85 });
    expect(fs.readFileSync(logFile, 'utf8')).not.toMatch(/README|changelog/);
  });

  it('wire error → regex-only result, one attempt', async () => {
    setEnv(ON);
    const fetchImpl = stubFailingWire(),
      r = await shouldAutoCaptureWithJudge(PLAIN_TEXT, { judge: buildAutosaveJudge() });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.match).toBe(false);
    expect(r.source).toBeUndefined();
  });
});

describe('dream — advisory review through the real judge', () => {
  it('each pair under its own keys (memory_a_i / memory_b_i), verdicts per pair', async () => {
    setEnv(ON);
    const { fetchImpl, bodies } = stubLiquid((q, a) => ({ noul: a && a.id === 1 ? 0.9 : 0.05 })),
      sqlJson = (sql) =>
        /CORRECTION/.test(sql)
          ? []
          : [
              { id: 1, title: 'A', content: 'a', newer_id: 2, newer_title: 'A2', newer_content: 'a2' },
              { id: 3, title: 'B', content: 'b', newer_id: 4, newer_title: 'C', newer_content: 'c' },
            ],
      r = await dreamDecisionReview({ sqlJson }, {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.keys(bodies[0].state).sort()).toEqual(['memory_a_0', 'memory_a_1', 'memory_b_0', 'memory_b_1']);
    expect(r.superseded.verified.map((v) => v.verdict)).toEqual(['superseded', 'keep']);
    expect(logLines()[0]).toMatchObject({ surface: 'dream', status: 'ok', superseded: 2, corrections: 0 });
  });
});

describe('kill switches — each surface off means no request at all', () => {
  const entry = {
    recall: () => searchDecisionEnabled(),
    dedupe: () => dedupeDecisionEnabled(),
    trust: () => trustDecisionEnabled(),
    guard: () => guardDecisionEnabled(),
    autosave: () => buildAutosaveJudge() !== null,
    dream: () => dreamDecisionEnabled(),
    context: () => contextDecisionEnabled(),
  };

  it.each(SURFACES)('LAPIS_JUDGE_DISABLE_%s=1 turns that surface off and only that one', (surface) => {
    setEnv({ ...ON, [`LAPIS_JUDGE_DISABLE_${surface.toUpperCase()}`]: '1' });
    expect(entry[surface]()).toBe(false);
    expect(surfaceEnabled(surface)).toBe(false);
    for (const other of SURFACES.filter((s) => s !== surface)) {
      expect(entry[other]()).toBe(true);
    }
  });

  it('LAPIS_JUDGE_LOCAL_ONLY=1 turns every surface off', () => {
    setEnv({ ...ON, LAPIS_JUDGE_LOCAL_ONLY: '1' });
    for (const s of SURFACES) {
      expect(entry[s]()).toBe(false);
    }
  });

  it('disabled entry points make no request: guard → sync, trust/dream → null', async () => {
    setEnv({
      ...ON,
      LAPIS_JUDGE_DISABLE_GUARD: '1',
      LAPIS_JUDGE_DISABLE_TRUST: '1',
      LAPIS_JUDGE_DISABLE_DREAM: '1',
    });
    const { fetchImpl } = stubLiquid(() => ({ choice: 'list', confidence: 0.9 }));
    expect(await maybeClassifyCommand(['du', '-sh', '.'], {})).toBe('generic');
    expect(await maybeTrustDecisionReview([{ memory_id: 1, symbol_id: 'x' }], ['x'], null)).toBeNull();
    expect(await maybeDreamDecisionReview({ sqlJson: () => [] })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logLines()).toEqual([]);
  });

  it('no key → every surface off', () => {
    setEnv({ LAPIS_JUDGE_PROVIDER: 'decision' });
    for (const s of SURFACES) {
      expect(entry[s]()).toBe(false);
    }
  });
});
