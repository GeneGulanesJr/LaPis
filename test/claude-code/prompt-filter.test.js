// Vitest globals enabled — no import
//
// Relevance filter for the Claude Code UserPromptSubmit memory context.
// Modules: src/claude-code/prompt-filter.js, judgePromptRelevance in context-decision.js.
// The judge is mocked at the wire — a stubbed global fetch answers the Liquid
// Decisions API request — so the whole path (handler → filter → judge →
// Decision adapter) runs for real.
//
// The examples are the irrelevant injections seen in a real session on
// 2026-10-16; the probabilities are the ones Liquid (d1-ultra) returned for
// Them on the same day (rounded), plus clearly relevant controls.

const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  realStateStore = require('../../src/claude-code/state-store'),
  { handleUserPromptSubmit } = require('../../src/claude-code/handlers/user-prompt-submit'),
  {
    filterPromptContext,
    prefilterPreflight,
    prefilterCodingContext,
    finalizePreflight,
  } = require('../../src/claude-code/prompt-filter'),
  { judgePromptRelevance, decisionSelectContext } = require('../../src/memory-domain/context-decision'),
  { createJudge } = require('../../src/judgment'),
  { resetConfigCache, CONFIG_PATH } = require('../../config'),
  ENV_KEYS = ['LAPIS_JUDGE_PROVIDER', 'LAPIS_JUDGE_DISABLE_CONTEXT', 'LIQUID_API_KEY', 'LAPIS_JUDGE_LOG'],
  OLD_MACHINE = '/home/genegulanesjr/Documents/Curacall/Retell.Frontend/archive';

let saved, tmpDir, logFile;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-prompt-filter-'));
  logFile = path.join(tmpDir, 'judgment.log');
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'decision.js'), '// real file\n');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
  } catch {
    // No config written
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

const ON = { LAPIS_JUDGE_PROVIDER: 'decision', LIQUID_API_KEY: 'k-test' },
  OFF = { LAPIS_JUDGE_PROVIDER: 'heuristic' };

/** Label of a judged candidate (what the stub keys its probability on). */
function labelOf(fields) {
  return fields.title || fields.symbol || fields.file;
}

/**
 * Stub the Liquid wire: answers every noul question with pByLabel[label]
 * (default 0.05). Records each parsed request body.
 */
function stubLiquid(pByLabel = {}, { fail } = {}) {
  const bodies = [],
    fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (fail === 'reject') {
        throw new Error('ECONNRESET');
      }
      if (fail === 'http') {
        return { ok: false, status: 500, text: async () => 'boom' };
      }
      if (fail === 'hang') {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        const key = /`(candidate_\d+)`/.exec(q.instructions)[1],
          label = labelOf(body.state[key]);
        answers[id] = { type: q.type, noul: pByLabel[label] ?? 0.05 };
      }
      return { ok: true, status: 200, json: async () => ({ answers }) };
    });
  vi.stubGlobal('fetch', fetchImpl);
  return { fetchImpl, bodies };
}

function makeStateStore() {
  const map = new Map();
  return {
    defaultState: realStateStore.defaultState,
    loadState: (id) => map.get(id) || realStateStore.defaultState(),
    saveState: (id, s) => map.set(id, s),
    mutateState: async (id, mutator) => {
      const s = map.get(id) || realStateStore.defaultState(),
        r = await mutator(s);
      map.set(id, s);
      return r;
    },
  };
}

function mem(id, title, content = `**What**: ${title}`) {
  return { id, type: 'decision', title, content, trust_score: 0.9 };
}

function sug(id, title, project) {
  return { id, type: 'decision', title, project };
}

/** Run the real UPS handler against a fake dispatch. */
async function runPrompt({ prompt, observations = [], cross = [], preflight = null, codingContext = null }) {
  const calls = [],
    dispatch = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'context') {
        return {
          observations,
          personal: [],
          cross_project_suggestions: cross,
          stats: { total_memories: 10, total_personal: 0 },
        };
      }
      if (cmd === 'preflight') {
        return preflight || { risk: 'low', likely_existing_code: [], duplicate_warnings: [], related_files: [] };
      }
      if (cmd === 'coding-context') {
        return codingContext || { data: {} };
      }
      return {};
    },
    repo = { name: 'retellmcp', path: tmpDir, file_count: 1, symbol_count: 1, indexed_at: new Date().toISOString() },
    out = await handleUserPromptSubmit({
      payload: { session_id: 'pf-test', prompt, cwd: tmpDir },
      dispatch,
      getKnownRepos: () => [repo],
      stateStore: makeStateStore(),
    });
  return { text: out ? out.hookSpecificOutput.additionalContext : '', calls };
}

function logLines() {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// The session's irrelevant injections → dropped
// ---------------------------------------------------------------------------

describe('prompt filter — the irrelevant injections of 2026-10-16 are dropped', () => {
  const CASES = [
    {
      prompt: 'What about the Pi Skills can you list them out',
      observations: [mem(23337, 'round11-payroll — consolidated (4 entries) Round-11 QA payroll diagnosis')],
      cross: [
        sug(29512, 'PP2 MMDA routing rules: in Technical Proposal 3.3, priced', 'ProjectKairos'),
        sug(29762, 'pp2-submission-package — consolidated (3 entries)', 'ProjectKairos'),
      ],
      p: { 'round11-payroll — consolidated (4 entries) Round-11 QA payroll diagnosis': 0.05 },
    },
    {
      prompt: 'Can you add this key to both claude and pi as env key (Liquid API key)',
      observations: [mem(23816, 'Webhook→XRM pipeline rebuilt: receiver v9.0')],
      cross: [sug(26349, 'Aelvyril Slice 1 reviewer warnings — to address in Slice 4 wiring', 'aelvyril')],
      p: { 'Webhook→XRM pipeline rebuilt: receiver v9.0': 0.08 },
    },
    {
      prompt: 'Disable the cocomit for claude code pls',
      observations: [mem(23301, 'Webhook disabled on Retell (Aila v117, Max v111)')],
      cross: [sug(29764, 'PP2 Art. 20.3 generative-AI approval request letter drafted', 'ProjectKairos')],
      p: { 'Webhook disabled on Retell (Aila v117, Max v111)': 0.02 },
    },
    {
      prompt: 'Remove the cursor and codex skills',
      observations: [mem(23420, 'retell-control MCP installed in Claude Code + Cursor (project scope)')],
      cross: [sug(23781, 'RoadSight grab cursor — Leaflet canvas leaflet-interactive hid it', 'genegulanesjr')],
      // Weakly related: Liquid gave it 0.15 — below the 0.5 threshold.
      p: { 'retell-control MCP installed in Claude Code + Cursor (project scope)': 0.15 },
    },
  ];

  for (const c of CASES) {
    it(`"${c.prompt}" → no Prompt-Matched Memory, no Cross-Project Suggestions`, async () => {
      setEnv(ON);
      const { fetchImpl } = stubLiquid(c.p),
        { text } = await runPrompt(c);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(text).toContain('## Memory Context (auto-loaded)');
      expect(text).not.toContain('### Prompt-Matched Memory');
      expect(text).not.toContain('### Cross-Project Suggestions');
      for (const o of c.observations) {
        expect(text).not.toContain(o.title);
      }
    });
  }

  it('"Merged can you run pi update --extensions pls" → old-machine preflight paths dropped before the judge', async () => {
    setEnv(ON);
    const { bodies } = stubLiquid({}),
      { text } = await runPrompt({
        prompt: 'Merged can you run pi update --extensions pls',
        observations: [mem(23627, 'round14-payroll-QA — 3 decisions LOCKED')],
        preflight: {
          risk: 'high',
          duplicate_warnings: [{ symbol: 'update', file: `${OLD_MACHINE}/fixes/fix-aug10-feedback-issues.mjs` }],
          likely_existing_code: [
            { symbol: 'update', kind: 'function', file: `${OLD_MACHINE}/fixes/fix-aug10-feedback-issues.mjs`, line: 3 },
          ],
          related_files: [`${OLD_MACHINE}/fixes/fix-aug10-feedback-issues.mjs`],
          recommended_action: `Review and extend existing update in ${OLD_MACHINE}/fixes/fix-aug10-feedback-issues.mjs`,
        },
      });
    expect(text).not.toContain('Preflight');
    expect(text).not.toContain('Duplicate risk');
    expect(text).not.toContain('/home/genegulanesjr');
    // The judge was never asked about the missing paths.
    expect(JSON.stringify(bodies)).not.toContain('/home/genegulanesjr');
    expect(logLines()[0].missing_paths).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Relevant candidates stay
// ---------------------------------------------------------------------------

describe('prompt filter — relevant candidates stay', () => {
  it("R110 Jenna's 'Yes, I can hear you' → the R110 memory stays, the older round is dropped", async () => {
    setEnv(ON);
    stubLiquid({
      "R110 published — Jenna's 'Yes, I can hear you.' then the role question": 0.92,
      'R62–R65 + Aila voice pilot shipped 2026-10-05': 0.15,
    });
    const { text } = await runPrompt({
      prompt: "R110 Jenna's 'Yes, I can hear you'",
      observations: [
        mem(29111, 'R62–R65 + Aila voice pilot shipped 2026-10-05'),
        mem(30100, "R110 published — Jenna's 'Yes, I can hear you.' then the role question"),
      ],
      cross: [sug(22887, 'Jenna door-concerned silence bug — structural, not instructional', 'genegulanesjr')],
    });
    expect(text).toContain('### Prompt-Matched Memory');
    expect(text).toContain("R110 published — Jenna's 'Yes, I can hear you.'");
    expect(text).not.toContain('R62–R65');
    expect(text).not.toContain('### Cross-Project Suggestions');
  });

  it('a relevant memory ranked below an irrelevant one takes the injection slot', async () => {
    setEnv(ON);
    // Liquid, 2026-10-16: 0.99 / 0.30 / 0.38 for these three on this prompt.
    stubLiquid({
      'retell-sdk UPGRADED 5.66.1 → 6.2.5 on 2026-10-12 after a sandbox test + passing canary sim': 0.99,
      'SDK downgrade: retell-sdk 6.0.1 → 5.66.1 [SUPERSEDED]': 0.3,
      'R97 PUBLISHED 2026-10-13 (Aila v245 flows / v246 form)': 0.38,
    });
    const { text } = await runPrompt({
      prompt: 'When did we upgrade retell-sdk to 6.2.5 and what was the canary sim?',
      observations: [
        mem(29795, 'R97 PUBLISHED 2026-10-13 (Aila v245 flows / v246 form)'),
        mem(29790, 'retell-sdk UPGRADED 5.66.1 → 6.2.5 on 2026-10-12 after a sandbox test + passing canary sim'),
        mem(25404, 'SDK downgrade: retell-sdk 6.0.1 → 5.66.1 [SUPERSEDED]'),
      ],
    });
    expect(text).toContain('retell-sdk UPGRADED 5.66.1 → 6.2.5');
    expect(text).not.toContain('R97 PUBLISHED');
  });

  it('a relevant cross-project suggestion and an existing preflight file stay', async () => {
    setEnv(ON);
    const realFile = path.join(tmpDir, 'src', 'decision.js');
    stubLiquid({
      'LaPis judgment layer switched to Liquid Decisions API': 0.81,
      createDecisionAdapter: 0.77,
      [realFile]: 0.7,
    });
    const { text } = await runPrompt({
      prompt: 'Fix the createDecisionAdapter timeout handling',
      cross: [sug(30001, 'LaPis judgment layer switched to Liquid Decisions API', 'LaPis')],
      preflight: {
        risk: 'high',
        duplicate_warnings: [{ symbol: 'createDecisionAdapter', file: realFile }],
        likely_existing_code: [
          { symbol: 'createDecisionAdapter', kind: 'function', file: realFile, line: 43 },
          { symbol: 'update', kind: 'function', file: `${OLD_MACHINE}/x.mjs`, line: 1 },
        ],
        related_files: [realFile, `${OLD_MACHINE}/x.mjs`],
        recommended_action: `Review and extend existing createDecisionAdapter in ${realFile} before creating new code.`,
      },
    });
    expect(text).toContain('### Cross-Project Suggestions');
    expect(text).toContain('LaPis judgment layer switched to Liquid Decisions API (LaPis)');
    expect(text).toContain('### Preflight — Before Coding');
    expect(text).toContain(`\`createDecisionAdapter\` in \`${realFile}\``);
    expect(text).not.toContain(OLD_MACHINE);
  });
});

// ---------------------------------------------------------------------------
// Request shape, gates, fail-open, logging
// ---------------------------------------------------------------------------

describe('prompt filter — one request, gates and fail-open', () => {
  const SAMPLE = {
    prompt: 'Remove the cursor and codex skills',
    observations: [mem(23420, 'retell-control MCP installed in Claude Code + Cursor (project scope)')],
    cross: [sug(23781, 'RoadSight grab cursor', 'genegulanesjr'), sug(21480, 'Installed effective-html skill', 'x')],
  };

  it('one request for every section: noul questions, distinct candidate keys, the gateway selection skipped', async () => {
    setEnv(ON);
    const { fetchImpl, bodies } = stubLiquid({}),
      { calls } = await runPrompt(SAMPLE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [body] = bodies,
      questions = Object.values(body.questions);
    expect(questions).toHaveLength(3);
    expect(questions.every((q) => q.type === 'noul')).toBe(true);
    expect(body.state.prompt).toBe(SAMPLE.prompt);
    expect(Object.keys(body.state).filter((k) => k.startsWith('candidate_'))).toEqual([
      'candidate_0',
      'candidate_1',
      'candidate_2',
    ]);
    const contextCall = calls.find((c) => c.cmd === 'context');
    expect(contextCall.args['decision-select']).toBe('off');
  });

  async function offOutput() {
    setEnv(OFF);
    const { text, calls } = await runPrompt(SAMPLE);
    return { text, calls };
  }

  it('provider off → no request, no log line, no extra dispatch arg', async () => {
    const { fetchImpl } = stubLiquid({}),
      { text, calls } = await offOutput();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(text).toContain('retell-control MCP installed');
    expect(calls.find((c) => c.cmd === 'context').args).not.toHaveProperty('decision-select');
    expect(logLines()).toEqual([]);
  });

  it('kill switch LAPIS_JUDGE_DISABLE_CONTEXT=1 → exactly the off output, no request', async () => {
    const { text: expected } = await offOutput();
    setEnv({ ...ON, LAPIS_JUDGE_DISABLE_CONTEXT: '1' });
    const { fetchImpl } = stubLiquid({}),
      { text } = await runPrompt(SAMPLE);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(text).toBe(expected);
  });

  it('no LIQUID_API_KEY → exactly the off output, no request', async () => {
    const { text: expected } = await offOutput();
    setEnv({ LAPIS_JUDGE_PROVIDER: 'decision' });
    const { fetchImpl } = stubLiquid({}),
      { text } = await runPrompt(SAMPLE);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(text).toBe(expected);
  });

  for (const fail of ['reject', 'http']) {
    it(`provider failure (${fail}) → exactly the off output, logged as unavailable, one attempt (no retries)`, async () => {
      const { text: expected } = await offOutput();
      setEnv(ON);
      const { fetchImpl } = stubLiquid({}, { fail }),
        { text } = await runPrompt(SAMPLE);
      expect(text).toBe(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [line] = logLines();
      expect(line.status).toBe('unavailable');
    });
  }

  it('timeout → exactly the off output within the configured cap', async () => {
    const { text: expected } = await offOutput();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ judgment: { prompt_filter_timeout_ms: 150 } }));
    setEnv(ON);
    stubLiquid({}, { fail: 'hang' });
    const started = Date.now(),
      { text } = await runPrompt(SAMPLE),
      elapsed = Date.now() - started;
    expect(text).toBe(expected);
    expect(elapsed).toBeLessThan(1500);
    expect(logLines()[0].status).toBe('unavailable');
  });

  it('logs one line per prompt: counts, ids, probabilities and latency — no memory text', async () => {
    setEnv(ON);
    stubLiquid({ 'Installed effective-html skill': 0.6 });
    await runPrompt(SAMPLE);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      surface: 'context',
      hook: 'UserPromptSubmit',
      status: 'ok',
      threshold: 0.5,
      kept: { memory: 0, suggestion: 1, code: 0, file: 0 },
      dropped: { memory: 1, suggestion: 1, code: 0, file: 0 },
    });
    expect(typeof line.ms).toBe('number');
    expect(line.p.map((x) => x.id)).toEqual([23420, 23781, 21480]);
    const raw = fs.readFileSync(logFile, 'utf8');
    expect(raw).not.toContain('retell-control');
    expect(raw).not.toContain('effective-html');
    expect(raw).not.toContain(SAMPLE.prompt);
  });
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe('filterPromptContext — mocked judge', () => {
  const bag = {
    effectiveObservations: [mem(1, 'a'), mem(2, 'b')],
    crossProjectSuggestions: [sug(3, 'c', 'P')],
  };

  it('threshold 0.5 is inclusive; sections emptied by the judge come back empty', async () => {
    const judge = vi.fn(async () => ({ status: 'ok', p: [0.5, 0.49, 0.1] })),
      r = await filterPromptContext({ prompt: 'x', bag, preflight: null }, { judge, log: () => {} });
    expect(r.bag.effectiveObservations.map((o) => o.id)).toEqual([1]);
    expect(r.bag.crossProjectSuggestions).toEqual([]);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('unavailable / malformed / throwing judge → null (caller renders the unfiltered inputs)', async () => {
    for (const judge of [
      async () => ({ status: 'unavailable', reason: 'breaker open' }),
      async () => ({ status: 'ok', p: [0.9] }), // Wrong length
      async () => {
        throw new Error('boom');
      },
    ]) {
      expect(await filterPromptContext({ prompt: 'x', bag, preflight: null }, { judge, log: () => {} })).toBeNull();
    }
  });

  it('no candidates → no judge call, inputs returned', async () => {
    const judge = vi.fn(),
      r = await filterPromptContext(
        { prompt: 'x', bag: { effectiveObservations: [], crossProjectSuggestions: [] }, preflight: null },
        { judge, log: () => {} },
      );
    expect(judge).not.toHaveBeenCalled();
    expect(r.bag.effectiveObservations).toEqual([]);
  });
});

describe('preflight pre-filter', () => {
  it('drops missing absolute and relative paths, keeps existing ones and file-less entries', () => {
    const { result, dropped } = prefilterPreflight(
      {
        risk: 'high',
        duplicate_warnings: [{ symbol: 'a', file: `${OLD_MACHINE}/a.mjs` }, { symbol: 'b' }],
        likely_existing_code: [
          { symbol: 'c', file: 'src/decision.js' },
          { symbol: 'd', file: 'src/missing.js' },
        ],
        related_files: ['src/decision.js', `${OLD_MACHINE}/a.mjs`],
      },
      [tmpDir],
    );
    expect(dropped).toBe(3);
    expect(result.duplicate_warnings).toEqual([{ symbol: 'b' }]);
    expect(result.likely_existing_code.map((c) => c.symbol)).toEqual(['c']);
    expect(result.related_files).toEqual(['src/decision.js']);
  });

  it('finalizePreflight: everything gone → low risk, no action (block not rendered)', () => {
    const original = { risk: 'high', duplicate_warnings: [{ symbol: 'a', file: 'x' }], likely_existing_code: [] },
      r = finalizePreflight(original, { ...original, duplicate_warnings: [], related_files: [] });
    expect(r.risk).toBe('low');
    expect(r.recommended_action).toBeNull();
  });

  it('finalizePreflight: warnings gone, code kept → medium risk, action names the kept code', () => {
    const original = {
        risk: 'high',
        duplicate_warnings: [{ symbol: 'a', file: 'x.js' }],
        likely_existing_code: [{ symbol: 'k', file: 'k.js' }],
        related_files: [],
      },
      r = finalizePreflight(original, { ...original, duplicate_warnings: [] });
    expect(r.risk).toBe('medium');
    expect(r.recommended_action).toContain('Start from k in k.js');
  });

  it('coding-context lists lose missing paths', () => {
    const r = prefilterCodingContext(
      {
        target: { file: 'src/decision.js' },
        related_files: ['src/decision.js', `${OLD_MACHINE}/z.mjs`],
        likely_tests: [{ file: `${OLD_MACHINE}/z.test.mjs` }],
      },
      [tmpDir],
    );
    expect(r.related_files).toEqual(['src/decision.js']);
    expect(r.likely_tests).toEqual([]);
  });

  it('coding context whose target file is missing is dropped whole', () => {
    expect(
      prefilterCodingContext({ target: { symbol: 'key', file: `${OLD_MACHINE}/fix-aug17-round7c-restore.mjs` } }, [
        tmpDir,
      ]),
    ).toBeNull();
  });

  it('handler: a prompt-derived coding-context target on an old-machine path is not rendered', async () => {
    setEnv(ON);
    stubLiquid({});
    const { text } = await runPrompt({
      prompt: 'Fix the env key (Liquid API key) handling',
      codingContext: {
        data: {
          target: { symbol: 'key', file: `${OLD_MACHINE}/fixes/fix-aug17-round7c-restore.mjs` },
          summary: { risk: 'medium', review_bar: 'normal-plus', affected_files: 0 },
        },
      },
    });
    expect(text).not.toContain('Coding Context');
    expect(text).not.toContain(OLD_MACHINE);
  });
});

describe('judgePromptRelevance', () => {
  it('caps the request at 128 questions; the rest are kept (p = 1)', async () => {
    const judge = vi.fn(async (qs) => ({
        status: 'ok',
        answers: qs.map((q) => ({ id: q.id, p: 0.2, confidence: 0.6 })),
      })),
      candidates = Array.from({ length: 130 }, (_, i) => ({ kind: 'memory', fields: { title: `m${i}` } })),
      r = await judgePromptRelevance('prompt', candidates, { _judge: judge });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toHaveLength(128);
    expect(judge.mock.calls[0][1]).toEqual({ surface: 'context' });
    expect(r.p.slice(126)).toEqual([0.2, 0.2, 1, 1]);
  });

  it('judge unavailable or throwing → unavailable, never throws', async () => {
    const one = [{ kind: 'memory', fields: { title: 'a' } }];
    expect(
      (await judgePromptRelevance('p', one, { _judge: async () => ({ status: 'unavailable', reason: 'x' }) })).status,
    ).toBe('unavailable');
    expect(
      (
        await judgePromptRelevance('p', one, {
          _judge: async () => {
            throw new Error('x');
          },
        })
      ).status,
    ).toBe('unavailable');
  });
});

describe('regressions found while wiring the filter', () => {
  it('decisionSelectContext without an injected judge really calls the provider (buildJudge returned an object before)', async () => {
    setEnv(ON);
    const { fetchImpl } = stubLiquid({});
    // StubLiquid answers noul; this surface asks score questions — answer those too.
    fetchImpl.mockImplementationOnce(async (url, init) => {
      const body = JSON.parse(init.body),
        answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { score: 2, confidence: 0.9 }]));
      return { ok: true, status: 200, json: async () => ({ answers }) };
    });
    const r = await decisionSelectContext([{ id: 1, title: 'A', content: 'a' }], 'task', {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.unavailable).toBeUndefined();
    expect(r.selected.map((c) => c.id)).toEqual([1]);
  });

  it('createJudge clears its timeout timer once the adapter answers', async () => {
    vi.useFakeTimers();
    try {
      const judge = createJudge({
        config: { judgment: { provider: 'decision', timeout_ms: 5000, disables: {} } },
        adapters: { decision: { judge: async () => ({ status: 'ok', answers: [] }) } },
      });
      await judge.judge([], { surface: 'context' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
