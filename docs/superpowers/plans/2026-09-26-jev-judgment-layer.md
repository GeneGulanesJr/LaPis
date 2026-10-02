# Judgment Layer Slice 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-agnostic `src/judgment/` core (contract, internal kernel, policy evaluation, heuristic + Jev adapters, total-function `judge()` with circuit breaker, config wiring, goldens, docs) — zero call-site wiring (Slices 1–2 come later).

**Architecture:** LaPis owns the judgment vocabulary (`classify` / `probability` / `grade`). Providers are adapters behind `JudgeAdapter`. `judge()` never throws: off/missing-key/timeout/malformed all return `unavailable`/`invalid` and call sites fall back to existing heuristics. Polarity ("dangerous" answers) is declared on questions and evaluated only via pure functions in `evaluate.js`.

**Tech Stack:** Node CJS (`.js` + JSDoc — house style for `src/`; the spec's `.ts` sketch is aligned to this), vitest **with globals** (existing tests never import vitest — do NOT add `require('vitest')`), oxlint + oxfmt (`npm run check`). Jev wire contract ported from the proven RetellMCP `qa/jev.mjs` (POST `https://api.typesafe.ai/v1/systemone`, Bearer `TYPESAFE_API_KEY`, body `{model, state, questions}`, reply `{answers: {id: {noul|choice|score, confidence}}, model, usage}`).

**Spec:** `docs/superpowers/specs/2026-09-26-jev-judgment-layer-design.md`

---

## File Structure

```
src/judgment/
  contract.js        ← JSDoc types + assertValidQuestion/assertValidAnswers (boundary validation)
  internal.js        ← shared kernel: normalizeScore, band, capText, chunk, CONFIDENT_THRESHOLD
  evaluate.js        ← pure policy evaluation (polarity, confidence floors, escalation)
  index.js           ← createJudge(): registry, total-function judge(), timeout, circuit breaker
  adapters/
    heuristic.js     ← always `unavailable` (default provider; "off" is first-class)
    jev.js           ← TypeSafe System One wire adapter (the ONLY file that knows Jev)
config.js            ← MODIFY: add `judgment` DEFAULTS section + LAPIS_JUDGE_* env overrides
test/
  judgment-contract.test.js
  judgment-internal.test.js
  judgment-evaluate.test.js
  judgment-heuristic.test.js
  judgment-jev.test.js          ← wire tests via injected fetchImpl (NO network)
  judgment-index.test.js        ← total-function + breaker tests (fake adapters, fake timers)
  judgment-goldens.test.js      ← provider-neutral golden replay
  judgment-goldens/
    dream-supersession.json
    autosave-classify.json
docs/JUDGMENT.md       ← flag matrix + per-surface egress table
```

**Testing note for every task:** run one file with `npx vitest run test/<file>` — expected output ends with `Test Files  1 passed`. Full suite: `npm test`.

---

### Task 0: Feature branch

**Files:** none (git only)

- [ ] **Step 1: Create and switch to the feature branch**

```bash
cd /Users/genejrgulanes/Documents/GulanesKorp/LaPis
git checkout -b feat/judgment-layer
```

Expected: `Switched to a new branch 'feat/judgment-layer'`

---

### Task 1: Shared kernel — `src/judgment/internal.js`

**Files:**
- Create: `src/judgment/internal.js`
- Test: `test/judgment-internal.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-internal.test.js
// vitest globals are enabled (house style); do not import vitest
const { normalizeScore, band, capText, chunk, CONFIDENT_THRESHOLD } = require('../src/judgment/internal');

describe('normalizeScore', () => {
  it('clamps to [0,1] and forces float', () => {
    expect(normalizeScore(0.5)).toBe(0.5);
    expect(normalizeScore(-1)).toBe(0);
    expect(normalizeScore(2)).toBe(1);
    expect(normalizeScore(1)).toBe(1);        // integer input still allowed, value is float
  });
  it('returns null for non-numeric (incl. NaN)', () => {
    expect(normalizeScore(NaN)).toBeNull();
    expect(normalizeScore('0.9')).toBeNull();
    expect(normalizeScore(null)).toBeNull();
    expect(normalizeScore(undefined)).toBeNull();
  });
});

describe('band', () => {
  // ONE convention: inclusive lower bounds everywhere (spec §12).
  it('bands with inclusive lower bounds', () => {
    expect(band(0.9, { high: 0.8, medium: 0.5 })).toBe('high');
    expect(band(0.8, { high: 0.8, medium: 0.5 })).toBe('high');   // inclusive
    expect(band(0.5, { high: 0.8, medium: 0.5 })).toBe('medium'); // inclusive
    expect(band(0.1, { high: 0.8, medium: 0.5 })).toBe('low');
  });
});

describe('capText', () => {
  it('truncates with ellipsis marker', () => {
    expect(capText('abcdef', 4)).toBe('abcd…');
    expect(capText('abc', 4)).toBe('abc');
  });
});

describe('chunk', () => {
  it('splits into n-sized chunks; rejects n < 1', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(/chunk size/);
  });
});

it('exports the single CONFIDENT_THRESHOLD', () => {
  expect(CONFIDENT_THRESHOLD).toBe(0.6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-internal.test.js`
Expected: FAIL — `Cannot find module '../src/judgment/internal'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/judgment/internal.js
// Shared kernel for the judgment layer (spec §12). Exists from day one to
// prevent the cross-file duplication the RetellMCP review found (memory #26800 P3).

// ONE confidence floor for the whole layer. Do not redefine this elsewhere.
const CONFIDENT_THRESHOLD = 0.6;

/** Coerce to a finite float in [0,1]; null when not numeric. (Contract rule R2.) */
function normalizeScore(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null; // Number(null)===0 and Number('0.9') coerce — guard type first
  return Math.min(1, Math.max(0, x));
}

/** Ordered banding, inclusive lower bounds. thresholds: {high, medium} upper bounds. */
function band(p, thresholds) {
  if (p >= thresholds.high) return 'high';
  if (p >= thresholds.medium) return 'medium';
  return 'low';
}

/** Truncate text to n chars with a single-char ellipsis marker. */
function capText(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  return s.slice(0, n) + '…';
}

/** Split arr into n-sized chunks. Throws on n < 1 (RetellMCP P2: chunk 0 looped forever). */
function chunk(arr, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`chunk size must be a positive integer, got ${n}`);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

module.exports = { normalizeScore, band, capText, chunk, CONFIDENT_THRESHOLD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-internal.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/judgment/internal.js test/judgment-internal.test.js
git commit -m "feat(judgment): shared kernel (normalizeScore/band/capText/chunk, single CONFIDENT_THRESHOLD)"
```

---

### Task 2: Contract — `src/judgment/contract.js`

**Files:**
- Create: `src/judgment/contract.js`
- Test: `test/judgment-contract.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-contract.test.js
// vitest globals are enabled (house style); do not import vitest
const { assertValidQuestion, assertValidAnswers, SURFACES } = require('../src/judgment/contract');

const classifyQ = {
  id: 'msg-type',
  judgment: { kind: 'classify', enum: ['decision', 'bugfix', 'discovery', 'pattern', 'nothing'] },
  instructions: 'Classify the assistant message.',
  state: { message: 'Shipped X because Y' },
};
const probQ = {
  id: 'superseded',
  judgment: { kind: 'probability', claim: 'A is superseded by B' },
  instructions: 'Judge supersession.',
  state: { a: 'old title', b: 'new title' },
};

describe('assertValidQuestion', () => {
  it('accepts classify and probability questions', () => {
    expect(() => assertValidQuestion(classifyQ)).not.toThrow();
    expect(() => assertValidQuestion(probQ)).not.toThrow();
  });
  it('rejects missing id/instructions/state and unknown kinds', () => {
    expect(() => assertValidQuestion({ ...classifyQ, id: undefined })).toThrow(/id/);
    expect(() => assertValidQuestion({ ...classifyQ, instructions: '' })).toThrow(/instructions/);
    expect(() => assertValidQuestion({ ...classifyQ, state: {} })).toThrow(/state/);
    expect(() => assertValidQuestion({ ...classifyQ, judgment: { kind: 'vibe' } })).toThrow(/kind/);
  });
  it('rejects classify without non-empty enum', () => {
    expect(() => assertValidQuestion({ ...classifyQ, judgment: { kind: 'classify', enum: [] } })).toThrow(/enum/);
  });
  it('rejects probability without claim', () => {
    expect(() => assertValidQuestion({ id: 'x', judgment: { kind: 'probability' }, instructions: 'i', state: { a: 1 } })).toThrow(/claim/);
  });
  it('rejects grade without 2+ levels', () => {
    expect(() => assertValidQuestion({ id: 'x', judgment: { kind: 'grade', levels: ['only'] }, instructions: 'i', state: { a: 1 } })).toThrow(/levels/);
  });
});

describe('assertValidAnswers', () => {
  it('accepts well-formed answers and validates answer field per kind', () => {
    const answers = [
      { id: 'msg-type', pick: 'decision', confidence: 0.9 },
      { id: 'superseded', p: 0.2, confidence: 0.8 },
    ];
    expect(() => assertValidAnswers([probQ, classifyQ], answers)).not.toThrow();
  });
  it('rejects unknown answer ids and kind/field mismatches (R3: malformed = invalid)', () => {
    expect(() => assertValidAnswers([probQ], [{ id: 'nope', p: 1, confidence: 1 }])).toThrow(/unknown answer id/);
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', confidence: 0.9 }])).toThrow(/p/);          // missing p
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', p: 'high', confidence: 0.9 }])).toThrow(/p/); // non-numeric p
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', p: 5, confidence: 0.9 }])).toThrow(/p/);      // out of range
    expect(() => assertValidAnswers([classifyQ], [{ id: 'msg-type', pick: 'alien', confidence: 0.9 }])).toThrow(/enum/);
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', p: 0.5 }])).toThrow(/confidence/);
  });
});

it('exports the known surface list for flag/docs matrix', () => {
  expect(SURFACES).toContain('dream');
  expect(SURFACES).toContain('autosave');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-contract.test.js`
Expected: FAIL — `Cannot find module '../src/judgment/contract'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/judgment/contract.js
// LaPis-owned judgment vocabulary (spec §6). Provider names (choice/noul/score)
// NEVER appear outside adapters/jev.js (rule R1).
//
// Question = {
//   id: string,
//   judgment: { kind: 'classify', enum: string[], dangerous?: string }   // dangerous = the enum value meaning "unsafe/bad"
//            | { kind: 'probability', claim: string }                    // claim true ≈ p > 0.5
//            | { kind: 'grade', levels: string[] },                      // ordered low → high
//   instructions: string,       // self-contained meaning
//   state: object,              // named fields; sent to provider as JSON state
// }
// Answer = { id, pick?|p?|level?, confidence }   // confidence ∈ [0,1]
// Result = { status: 'ok', answers } | { status: 'unavailable', reason } | { status: 'invalid', reason }

/** Surfaces that will consume judgments (docs/JUDGMENT.md flag matrix keys). */
const SURFACES = ['dream', 'autosave', 'dedupe', 'guard', 'recall', 'trust', 'context'];

/** Throws with a precise message when q is not a well-formed Question. */
function assertValidQuestion(q) {
  if (!q || typeof q !== 'object') throw new Error('question must be an object');
  if (typeof q.id !== 'string' || q.id.length === 0) throw new Error('question.id must be a non-empty string');
  const j = q.judgment;
  if (!j || typeof j !== 'object') throw new Error('question.judgment is required');
  if (j.kind === 'classify') {
    if (!Array.isArray(j.enum) || j.enum.length === 0) throw new Error('classify judgment requires non-empty enum');
    if (j.dangerous !== undefined && !j.enum.includes(j.dangerous)) throw new Error('classify.dangerous must be one of enum');
  } else if (j.kind === 'probability') {
    if (typeof j.claim !== 'string' || j.claim.length === 0) throw new Error('probability judgment requires claim');
  } else if (j.kind === 'grade') {
    if (!Array.isArray(j.levels) || j.levels.length < 2) throw new Error('grade judgment requires 2+ levels');
  } else {
    throw new Error(`unknown judgment kind: ${j.kind}`);
  }
  if (typeof q.instructions !== 'string' || q.instructions.length === 0) throw new Error('question.instructions must be a non-empty string');
  if (!q.state || typeof q.state !== 'object' || Array.isArray(q.state) || Object.keys(q.state).length === 0) {
    throw new Error('question.state must be a non-empty object');
  }
}

function _isFinite01(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}

/** Boundary validation (rule R3): throws when answers don't satisfy the questions. */
function assertValidAnswers(questions, answers) {
  if (!Array.isArray(answers)) throw new Error('answers must be an array');
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const a of answers) {
    const q = byId.get(a.id);
    if (!q) throw new Error(`unknown answer id: ${a.id}`);
    if (!_isFinite01(a.confidence)) throw new Error(`answer ${a.id}: confidence must be a number in [0,1]`);
    const kind = q.judgment.kind;
    if (kind === 'classify') {
      if (typeof a.pick !== 'string' || !q.judgment.enum.includes(a.pick)) {
        throw new Error(`answer ${a.id}: pick must be one of enum`);
      }
    } else if (kind === 'probability') {
      if (!_isFinite01(a.p)) throw new Error(`answer ${a.id}: p must be a number in [0,1]`);
    } else if (kind === 'grade') {
      if (!Number.isInteger(a.level) || a.level < 0 || a.level >= q.judgment.levels.length) {
        throw new Error(`answer ${a.id}: level must index levels`);
      }
    }
  }
}

module.exports = { assertValidQuestion, assertValidAnswers, SURFACES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-contract.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/judgment/contract.js test/judgment-contract.test.js
git commit -m "feat(judgment): LaPis-owned contract types + boundary validators"
```

---

### Task 3: Policy evaluation — `src/judgment/evaluate.js`

**Files:**
- Create: `src/judgment/evaluate.js`
- Test: `test/judgment-evaluate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-evaluate.test.js
// vitest globals are enabled (house style); do not import vitest
const { evaluate } = require('../src/judgment/evaluate');

const blockBad = {
  id: 'check',
  judgment: { kind: 'classify', enum: ['safe', 'unsafe'], dangerous: 'unsafe' },
  instructions: 'i',
  state: { a: 1 },
};
const probQ = {
  id: 'sup',
  judgment: { kind: 'probability', claim: 'A superseded by B' },
  instructions: 'i',
  state: { a: 1 },
};

describe('evaluate', () => {
  it('blocks dangerous picks at/above the confidence floor', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'unsafe', confidence: 0.9 }], threshold: 0.6 });
    expect(r.blocked.map((b) => b.id)).toEqual(['check']);
    expect(r.ok).toBe(false);
  });
  it('warns (not blocks) on sub-floor dangerous picks (RetellMCP P1 lesson)', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'unsafe', confidence: 0.4 }], threshold: 0.6 });
    expect(r.blocked).toEqual([]);
    expect(r.warned.map((w) => w.id)).toEqual(['check']);
    expect(r.ok).toBe(true);
  });
  it('escalates missing/unknown confidence instead of silently passing (§7 missing evidence)', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'unsafe', confidence: 0.4 }], threshold: 0.6, strictConfidence: true });
    expect(r.escalated.length).toBe(1);
  });
  it('blocks probability when claim is true (p > 0.5) at/above floor', () => {
    const r = evaluate({ questions: [probQ], answers: [{ id: 'sup', p: 0.93, confidence: 0.9 }], threshold: 0.6 });
    expect(r.blocked.map((b) => b.id)).toEqual(['sup']);
    const clean = evaluate({ questions: [probQ], answers: [{ id: 'sup', p: 0.1, confidence: 0.9 }], threshold: 0.6 });
    expect(clean.ok).toBe(true);
    expect(clean.blocked).toEqual([]);
  });
  it('safe picks never block regardless of confidence', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'safe', confidence: 0.1 }], threshold: 0.6 });
    expect(r.ok).toBe(true);
  });
  it('ignores answers for questions without a declared dangerous answer', () => {
    const benign = { id: 'b', judgment: { kind: 'classify', enum: ['x', 'y'] }, instructions: 'i', state: { s: 1 } };
    const r = evaluate({ questions: [benign], answers: [{ id: 'b', pick: 'x', confidence: 0.9 }], threshold: 0.6 });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-evaluate.test.js`
Expected: FAIL — `Cannot find module '../src/judgment/evaluate'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/judgment/evaluate.js
// Pure policy evaluation (spec §6 rule R4). The ONLY place dangerous-answer
// polarity is interpreted. Call sites never compare raw answers (RetellMCP
// P1 #1: polarity inversion happened when call sites did their own ===).
// Unit-tested without HTTP fakes by design.

/**
 * evaluate({ questions, answers, threshold, strictConfidence })
 *   questions: Question[] (as sent)
 *   answers:   Answer[] (from a status:'ok' Result)
 *   threshold: confidence floor for blocking (default from internal.CONFIDENT_THRESHOLD)
 *   strictConfidence: when true, sub-floor dangerous picks ESCALATE instead of warn
 * Returns { ok, blocked:[{id,reason}], warned:[...], escalated:[...] }
 * ok === blocked.length === 0 — warned/escalated never block (advisory rule).
 */
function evaluate({ questions, answers, threshold, strictConfidence = false }) {
  const floor = typeof threshold === 'number' ? threshold : require('./internal').CONFIDENT_THRESHOLD;
  const qById = new Map(questions.map((q) => [q.id, q]));
  const blocked = [];
  const warned = [];
  const escalated = [];

  for (const a of answers) {
    const q = qById.get(a.id);
    if (!q) continue; // validated upstream (R3); ignore silently here
    const j = q.judgment;

    let dangerous = false;
    let confidence = a.confidence;
    if (j.kind === 'classify' && j.dangerous !== undefined) {
      dangerous = a.pick === j.dangerous;
    } else if (j.kind === 'probability') {
      // claim true (p > 0.5) is the dangerous condition for probability questions
      dangerous = typeof a.p === 'number' && a.p > 0.5;
      if (dangerous && (confidence === undefined || confidence === null)) confidence = a.p; // use p when confidence absent
    }
    if (!dangerous) continue;

    const conf = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null;
    if (conf === null || conf < floor) {
      if (strictConfidence) {
        escalated.push({ id: a.id, reason: `dangerous answer with ${conf === null ? 'missing' : 'sub-floor'} confidence ${conf}` });
      } else {
        warned.push({ id: a.id, reason: `dangerous answer below confidence floor (${conf})` });
      }
    } else {
      blocked.push({ id: a.id, reason: `dangerous answer at confidence ${conf}` });
    }
  }

  return { ok: blocked.length === 0, blocked, warned, escalated };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-evaluate.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/judgment/evaluate.js test/judgment-evaluate.test.js
git commit -m "feat(judgment): pure policy evaluation — declarative polarity, floors, escalation"
```

---

### Task 4: Heuristic adapter — `src/judgment/adapters/heuristic.js`

**Files:**
- Create: `src/judgment/adapters/heuristic.js`
- Test: `test/judgment-heuristic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-heuristic.test.js
// vitest globals are enabled (house style); do not import vitest
const { createHeuristicAdapter } = require('../src/judgment/adapters/heuristic');

describe('heuristic adapter', () => {
  it('is the default provider name and probes healthy-off', async () => {
    const a = createHeuristicAdapter();
    expect(a.name).toBe('heuristic');
    const health = await a.probe();
    expect(health.ok).toBe(true);
    expect(health.mode).toBe('off');
  });
  it('always returns unavailable with a stable reason', async () => {
    const a = createHeuristicAdapter();
    const r = await a.judge([{ id: 'q1', judgment: { kind: 'probability', claim: 'c' }, instructions: 'i', state: { s: 1 } }]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/judgments off/i);
    expect(r.answers).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-heuristic.test.js`
Expected: FAIL — `Cannot find module '../src/judgment/adapters/heuristic'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/judgment/adapters/heuristic.js
// The default provider: judgments off. Returning `unavailable` (not throwing,
// not ok-with-empty) is what makes "off" a first-class, exercised path — every
// call site's fallback runs identically in tests and production defaults.

function createHeuristicAdapter() {
  return {
    name: 'heuristic',
    async probe() {
      return { ok: true, mode: 'off' };
    },
    async judge() {
      return { status: 'unavailable', reason: 'judgments off (heuristic provider)' };
    },
  };
}

module.exports = { createHeuristicAdapter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-heuristic.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/judgment/adapters/heuristic.js test/judgment-heuristic.test.js
git commit -m "feat(judgment): heuristic adapter — judgments-off as first-class default"
```

---

### Task 5: Jev wire adapter — `src/judgment/adapters/jev.js`

The ONLY file that knows TypeSafe. Wire contract ported verbatim from the proven
RetellMCP `qa/jev.mjs` (verified live 2026-09-25, memory #26775): POST `{endpoint}`,
Bearer `TYPESAFE_API_KEY`, body `{model, state, questions}`, reply `{answers:{id:{noul|choice|score, confidence}}, model, usage}`.

**Files:**
- Create: `src/judgment/adapters/jev.js`
- Test: `test/judgment-jev.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-jev.test.js
// Wire tests via injected fetchImpl — NO network, ungated (spec §11.1).
// vitest globals are enabled (house style): describe/it/expect/vi are globals — do not import vitest
const { createJevAdapter } = require('../src/judgment/adapters/jev');

const probQ = {
  id: 'sup',
  judgment: { kind: 'probability', claim: 'A superseded by B' },
  instructions: 'Judge supersession.',
  state: { a: 'old', b: 'new' },
};
const clsQ = {
  id: 'type',
  judgment: { kind: 'classify', enum: ['decision', 'nothing'], dangerous: 'decision' },
  instructions: 'classify it',
  state: { msg: 'x' },
};
const gradeQ = {
  id: 'rel',
  judgment: { kind: 'grade', levels: ['irrelevant', 'related', 'central'] },
  instructions: 'rate relevance',
  state: { q: 'query' },
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeAdapter(fetchImpl, overrides = {}) {
  return createJevAdapter({ apiKey: 'k-test', endpoint: 'https://fake.local/v1/systemone', fetchImpl, ...overrides });
}

describe('jev adapter — request side', () => {
  it('translates LaPis judgments to the wire (probability→noul, classify→choice, grade→score)', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = { url, opts, body: JSON.parse(opts.body) };
      return jsonResponse({ answers: { sup: { noul: 0.2, confidence: 0.8 }, type: { choice: 'decision', confidence: 0.9 }, rel: { score: 1, confidence: 0.7 } }, model: 'jev', usage: {} });
    });
    const a = makeAdapter(fetchImpl);
    const r = await a.judge([probQ, clsQ, gradeQ]);
    expect(r.status).toBe('ok');
    expect(captured.opts.headers.Authorization).toBe('Bearer k-test');
    expect(captured.body.model).toBe('jev-latest');
    // claim is folded into instructions so the wire question is self-contained
    expect(captured.body.questions.sup).toEqual({ type: 'noul', instructions: 'Judge supersession. Claim: A superseded by B' });
    // polarity is NOT annotated into criteria — dangerous-marking lives in evaluate.js only
    expect(captured.body.questions.type.criteria).toEqual({ decision: 'decision', nothing: 'nothing' });
    expect(captured.body.questions.rel.criteria).toEqual(['irrelevant', 'related', 'central']);
    // per-request `state` is the merge of every question's state (later wins)
    expect(captured.body.state).toEqual({ a: 'old', b: 'new', msg: 'x', q: 'query' });
  });
});

describe('jev adapter — response side', () => {
  it('maps and normalizes the reply to typed answers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ answers: { sup: { noul: 0.2, confidence: 0.8 }, type: { choice: 'decision', confidence: 0.9 }, rel: { score: 2, confidence: 0.7 } }, model: 'jev', usage: {} })
    );
    const r = await makeAdapter(fetchImpl).judge([probQ, clsQ, gradeQ]);
    expect(r.status).toBe('ok');
    expect(r.answers).toEqual([
      { id: 'sup', p: 0.2, confidence: 0.8 },
      { id: 'type', pick: 'decision', confidence: 0.9 },
      { id: 'rel', level: 2, confidence: 0.7 },
    ]);
  });
  it('non-2xx → unavailable (never throws)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'boom', json: async () => ({}) }));
    const r = await makeAdapter(fetchImpl).judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/HTTP 503/);
  });
  it('malformed-OK 200 → invalid, not crash (RetellMCP P1 #3)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ answers: { sup: { confidence: 0.9 } } })); // missing noul
    const r = await makeAdapter(fetchImpl).judge([probQ]);
    expect(r.status).toBe('invalid');
    expect(r.reason).toMatch(/sup/);
  });
  it('missing key → unavailable before any fetch (P1 #2)', async () => {
    const fetchImpl = vi.fn();
    const a = createJevAdapter({ apiKey: null, endpoint: 'https://fake.local', fetchImpl });
    const r = await a.judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/TYPESAFE_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('network throw → unavailable after retries', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await makeAdapter(fetchImpl, { maxRetries: 1 }).judge([probQ]);
    expect(r.status).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 + maxRetries
  });
  it('bad question (invalid enum ref) → invalid without fetching', async () => {
    const fetchImpl = vi.fn();
    const a = makeAdapter(fetchImpl);
    const r = await a.judge([{ ...clsQ, judgment: { kind: 'classify', enum: [] } }]);
    expect(r.status).toBe('invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-jev.test.js`
Expected: FAIL — `Cannot find module '../src/judgment/adapters/jev'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/judgment/adapters/jev.js
// TypeSafe System One (Jev) wire adapter — the ONLY file that knows Jev (spec §8, R1).
// Wire contract ported from RetellMCP qa/jev.mjs (live-verified 2026-09-25).
// Rules honored here: R2 normalization at the boundary, R3 validation (malformed
// OK → invalid), P1 #2 (missing key → unavailable before fetch).

const { assertValidQuestion, assertValidAnswers } = require('../contract');
const { normalizeScore } = require('../internal');

/** Translate one Question into the wire question shape. Throws on impossible translation. */
function buildWireQuestion(q) {
  const j = q.judgment;
  if (j.kind === 'probability') {
    return { type: 'noul', instructions: `${q.instructions} Claim: ${j.claim}` };
  }
  if (j.kind === 'classify') {
    // criteria = plain key→key map (RetellMCP convention). Polarity is NOT leaked
    // into the prompt — dangerous-marking is interpreted only by evaluate.js (R4).
    const criteria = Object.fromEntries(j.enum.map((k) => [k, k]));
    return { type: 'choice', instructions: q.instructions, criteria };
  }
  // grade
  return { type: 'score', instructions: q.instructions, criteria: j.levels };
}

function createJevAdapter({ apiKey, endpoint, fetchImpl, model, timeoutMs, maxRetries } = {}) {
  const _endpoint = endpoint || process.env.LAPIS_JUDGE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
  const _model = model || process.env.LAPIS_JUDGE_MODEL || 'jev-latest';
  const _timeoutMs = Number(timeoutMs ?? process.env.LAPIS_JUDGE_TIMEOUT_MS ?? 8000);
  const _maxRetries = Number(maxRetries ?? process.env.LAPIS_JUDGE_MAX_RETRIES ?? 2);
  const _fetch = fetchImpl || globalThis.fetch;

  async function post(body) {
    let lastErr;
    for (let attempt = 0; attempt <= _maxRetries; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), _timeoutMs);
        try {
          return await _fetch(_endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e;
        if (attempt < _maxRetries) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  return {
    name: 'jev',
    async probe() {
      if (!apiKey) return { ok: false, mode: 'missing-key' };
      return { ok: true, mode: 'ready', endpoint: _endpoint, model: _model };
    },
    async judge(questions) {
      // 1. missing key → unavailable BEFORE any work (P1 #2)
      if (!apiKey) return { status: 'unavailable', reason: 'TYPESAFE_API_KEY not set (machine-scoped; never project .env)' };
      // 2. validate + translate questions → invalid without fetching
      let wireQuestions;
      try {
        for (const q of questions) assertValidQuestion(q);
        wireQuestions = Object.fromEntries(questions.map((q) => [q.id, buildWireQuestion(q)]));
      } catch (e) {
        return { status: 'invalid', reason: e.message };
      }
      // 3. send (state merged per question is not supported by the wire; the
      //    full state goes in `state`, questions reference fields by name)
      const state = Object.assign({}, ...questions.map((q) => q.state));
      let res;
      try {
        res = await post({ model: _model, state, questions: wireQuestions });
      } catch (e) {
        return { status: 'unavailable', reason: `network: ${e.message}` };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        return { status: 'unavailable', reason: `HTTP ${res.status}: ${text}` };
      }
      // 4. validate + normalize the reply (R3) — malformed OK → invalid
      let body;
      try {
        body = await res.json();
      } catch (e) {
        return { status: 'invalid', reason: `reply not JSON: ${e.message}` };
      }
      const raw = body && body.answers ? body.answers : null;
      if (!raw || typeof raw !== 'object') return { status: 'invalid', reason: 'reply missing answers object' };
      const answers = [];
      for (const q of questions) {
        const a = raw[q.id];
        if (!a || typeof a !== 'object') return { status: 'invalid', reason: `reply missing answer ${q.id}` };
        const confidence = normalizeScore(a.confidence);
        const kind = q.judgment.kind;
        if (confidence === null) return { status: 'invalid', reason: `answer ${q.id}: bad confidence` };
        if (kind === 'probability') {
          const p = normalizeScore(a.noul);
          if (p === null) return { status: 'invalid', reason: `answer ${q.id}: bad noul` };
          answers.push({ id: q.id, p, confidence });
        } else if (kind === 'classify') {
          if (typeof a.choice !== 'string' || !q.judgment.enum.includes(a.choice)) {
            return { status: 'invalid', reason: `answer ${q.id}: choice outside enum` };
          }
          answers.push({ id: q.id, pick: a.choice, confidence });
        } else {
          const idx = Number(a.score);
          if (!Number.isInteger(idx) || idx < 0 || idx >= q.judgment.levels.length) {
            return { status: 'invalid', reason: `answer ${q.id}: score outside levels` };
          }
          answers.push({ id: q.id, level: idx, confidence });
        }
      }
      // Final contract check (defense in depth)
      try {
        assertValidAnswers(questions, answers);
      } catch (e) {
        return { status: 'invalid', reason: e.message };
      }
      return { status: 'ok', answers };
    },
  };
}

module.exports = { createJevAdapter, buildWireQuestion };
```

> **Note on `state`:** the System One wire takes one `state` object per request; per-question `state` objects are merged (later question fields win). Question `instructions` reference state fields by name. This matches how RetellMCP modules passed state.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-jev.test.js`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/judgment/adapters/jev.js test/judgment-jev.test.js
git commit -m "feat(judgment): Jev wire adapter — translation, validation, retry, never-throw"
```

---

### Task 6: Config — `judgment` section + env overrides

**Files:**
- Modify: `config.js` (DEFAULTS block, after `tool_guardrails`; and `applyEnvOverrides`)
- Test: `test/judgment-config.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-config.test.js
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { getConfig, resetConfigCache } = require('../config');

describe('judgment config section', () => {
  beforeEach(() => { resetConfigCache(); });
  afterEach(() => {
    delete process.env.LAPIS_JUDGE_PROVIDER;
    delete process.env.LAPIS_JUDGE_LOCAL_ONLY;
    delete process.env.LAPIS_JUDGE_DISABLE_DREAM;
    delete process.env.LAPIS_JUDGE_TIMEOUT_MS;
    resetConfigCache();
  });

  it('defaults to heuristic (OFF) per zero-cloud ethos (spec §4)', () => {
    const j = getConfig().judgment;
    expect(j.provider).toBe('heuristic');
    expect(j.local_only).toBe(false);
    expect(j.timeout_ms).toBe(5000);
    expect(j.max_retries).toBe(2);
    expect(j.confident_threshold).toBe(0.6);
    expect(j.breaker_threshold).toBe(3);
    expect(j.breaker_cooldown_ms).toBe(60000);
    expect(j.disables).toEqual({});
  });
  it('LAPIS_JUDGE_PROVIDER=jev opts in', () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    expect(getConfig().judgment.provider).toBe('jev');
  });
  it('LAPIS_JUDGE_LOCAL_ONLY=1 forces the kill switch', () => {
    process.env.LAPIS_JUDGE_LOCAL_ONLY = '1';
    expect(getConfig().judgment.local_only).toBe(true);
  });
  it('LAPIS_JUDGE_DISABLE_<SURFACE> lands in disables (lowercased)', () => {
    process.env.LAPIS_JUDGE_DISABLE_DREAM = '1';
    expect(getConfig().judgment.disables.dream).toBe(true);
  });
  it('numeric env overrides parse', () => {
    process.env.LAPIS_JUDGE_TIMEOUT_MS = '2500';
    expect(getConfig().judgment.timeout_ms).toBe(2500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-config.test.js`
Expected: FAIL — `expect(j.provider).toBe` receives `undefined`

- [ ] **Step 3: Implement**

In `config.js`, add to `DEFAULTS` (right after the `tool_guardrails: { ... }` block, before the closing `};`):

```js
    // Provider-agnostic semantic judgments (docs/JUDGMENT.md, spec 2026-09-26).
    // DEFAULT OFF — LaPis is zero-cloud/zero-keys by identity (spec §4);
    // opting in requires LAPIS_JUDGE_PROVIDER=jev AND a machine-scoped
    // TYPESAFE_API_KEY. Off = every call site keeps its heuristic fallback.
    judgment: {
      provider: 'heuristic', // 'heuristic' | 'jev' | 'off'
      timeout_ms: 5000,
      max_retries: 2,
      local_only: false, // kill switch: force heuristic path everywhere
      confident_threshold: 0.6,
      breaker_threshold: 3, // consecutive failures before the breaker opens
      breaker_cooldown_ms: 60000,
      disables: {}, // per-surface opt-outs, e.g. { dream: true }
    },
```

Then extend `applyEnvOverrides(config)` — add before its `return config;`:

```js
  const j = config.judgment || (config.judgment = {});
  if (process.env.LAPIS_JUDGE_PROVIDER) j.provider = process.env.LAPIS_JUDGE_PROVIDER;
  if (process.env.LAPIS_JUDGE_TIMEOUT_MS) {
    const n = parseInt(process.env.LAPIS_JUDGE_TIMEOUT_MS, 10);
    if (Number.isFinite(n)) j.timeout_ms = n;
  }
  if (process.env.LAPIS_JUDGE_LOCAL_ONLY === '1' || process.env.LAPIS_JUDGE_LOCAL_ONLY === 'true') {
    j.local_only = true;
  }
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^LAPIS_JUDGE_DISABLE_([A-Z0-9_]+)$/.exec(k);
    if (m && (v === '1' || v === 'true')) {
      j.disables = j.disables || {};
      j.disables[m[1].toLowerCase()] = true;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-config.test.js`
Expected: PASS (5 tests). Also confirm no config regressions: `npx vitest run test/mutation-killers.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add config.js test/judgment-config.test.js
git commit -m "feat(config): judgment section — provider/timeout/local_only/disables + LAPIS_JUDGE_* env"
```

---

### Task 7: Registry + total-function `judge()` — `src/judgment/index.js`

**Files:**
- Create: `src/judgment/index.js`
- Test: `test/judgment-index.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/judgment-index.test.js
const { describe, it, expect, vi, beforeEach, afterEach } = require('vitest');
const { createJudge } = require('../src/judgment/index');
const { createHeuristicAdapter } = require('../src/judgment/adapters/heuristic');

const q = { id: 'a', judgment: { kind: 'probability', claim: 'c' }, instructions: 'i', state: { s: 1 } };

function fakeConfig(over = {}) {
  return { judgment: { provider: 'jev', timeout_ms: 50, breaker_threshold: 2, breaker_cooldown_ms: 100, disables: {}, ...over } };
}

describe('createJudge — total-function guarantee (spec §7)', () => {
  it('provider off → unavailable without constructing an adapter', async () => {
    const j = createJudge({ config: fakeConfig({ provider: 'off' }), adapters: {} });
    const r = await j.judge([q]);
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/off/) });
  });
  it('unknown provider → unavailable, never throws', async () => {
    const j = createJudge({ config: fakeConfig({ provider: 'mystery' }), adapters: {} });
    const r = await j.judge([q]);
    expect(r.status).toBe('unavailable');
  });
  it('local_only kill switch forces unavailable even with jev selected', async () => {
    const spy = { judge: vi.fn(async () => ({ status: 'ok', answers: [{ id: 'a', p: 0.1, confidence: 0.9 }] })) };
    const j = createJudge({ config: fakeConfig({ local_only: true }), adapters: { jev: spy } });
    const r = await j.judge([q]);
    expect(r.status).toBe('unavailable');
    expect(spy.judge).not.toHaveBeenCalled();
  });
  it('disabled surface → unavailable', async () => {
    const j = createJudge({ config: fakeConfig({ disables: { dream: true } }), adapters: {} });
    const r = await j.judge([q], { surface: 'dream' });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/dream/);
  });
  it('hanging adapter → unavailable at timeout (never throws)', async () => {
    const hanging = { name: 'jev', judge: () => new Promise(() => {}) };
    const j = createJudge({ config: fakeConfig(), adapters: { jev: hanging } });
    const r = await j.judge([q]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/timeout/i);
  });
  it('happy path passes adapter answers through', async () => {
    const ok = { name: 'jev', judge: vi.fn(async () => ({ status: 'ok', answers: [{ id: 'a', p: 0.25, confidence: 0.8 }] })) };
    const j = createJudge({ config: fakeConfig(), adapters: { jev: ok } });
    const r = await j.judge([q]);
    expect(r.status).toBe('ok');
    expect(r.answers[0].p).toBe(0.25);
  });
});

describe('circuit breaker', () => {
  it('opens after threshold consecutive failures; calls skip the adapter; recovers after cooldown', async () => {
    vi.useFakeTimers();
    const failing = { name: 'jev', judge: vi.fn(async () => ({ status: 'unavailable', reason: 'HTTP 503' })) };
    const j = createJudge({ config: fakeConfig({ breaker_threshold: 2, breaker_cooldown_ms: 100 }), adapters: { jev: failing } });
    await j.judge([q]);
    await j.judge([q]);
    expect(failing.judge).toHaveBeenCalledTimes(2);
    const open = await j.judge([q]);
    expect(open.reason).toMatch(/breaker open/i);
    expect(failing.judge).toHaveBeenCalledTimes(2); // adapter skipped while open
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    // after cooldown the breaker half-opens and tries again
    const r = await j.judge([q]);
    expect(failing.judge).toHaveBeenCalledTimes(3);
    expect(r.status).toBe('unavailable'); // still failing upstream, but attempted
  });
});

it('heuristic default: createJudge() with no adapters uses heuristic and is unavailable', async () => {
  const j = createJudge({ config: { judgment: { provider: 'heuristic', timeout_ms: 50, breaker_threshold: 3, breaker_cooldown_ms: 100, disables: {} } } });
  const r = await j.judge([q]);
  expect(r.status).toBe('unavailable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/judgment-index.test.js`
Expected: FAIL — `Cannot find module '../src/judgment/index'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/judgment/index.js
// Registry + total-function judge() (spec §7). judge() NEVER throws — that is
// the structural guarantee that host flows can never block on judgment failure
// (RetellMCP P1 #2 made impossible by construction).

const { createHeuristicAdapter } = require('./adapters/heuristic');

/** Resolve the adapter for a provider name. Unknown → null (caller → unavailable). */
function pickAdapter(provider, adapters) {
  if (provider === 'heuristic') return createHeuristicAdapter();
  if (provider === 'off') return null;
  return adapters && adapters[provider] ? adapters[provider] : null;
}

/**
 * createJudge({ config, adapters })
 *   config:    getConfig() (uses .judgment section)
 *   adapters:  { jev?: JudgeAdapter } — registered provider adapters
 * Returns { provider, probe(), judge(questions, {surface}?) }.
 */
function createJudge({ config, adapters } = {}) {
  const cfg = () => (config && config.judgment) || {};
  const providerName = () => {
    const c = cfg();
    if (c.local_only) return 'heuristic'; // kill switch forces the off-path
    return c.provider || 'heuristic';
  };

  // Breaker state (per judge instance; CLI processes are short-lived anyway)
  let consecutiveFailures = 0;
  let openUntil = 0;

  async function probe() {
    const a = pickAdapter(providerName(), adapters);
    if (!a) return { ok: false, mode: providerName() };
    return a.probe ? a.probe() : { ok: true, mode: 'unknown' };
  }

  async function judge(questions, { surface } = {}) {
    const c = cfg();
    try {
      if (c.local_only) {
        return { status: 'unavailable', reason: 'LAPIS_JUDGE_LOCAL_ONLY=1 — heuristic path forced' };
      }
      if (surface && c.disables && c.disables[surface]) {
        return { status: 'unavailable', reason: `surface '${surface}' disabled (LAPIS_JUDGE_DISABLE_*)` };
      }
      const provider = c.provider || 'heuristic';
      if (provider === 'off') {
        return { status: 'unavailable', reason: 'judgment provider off' };
      }
      const adapter = pickAdapter(provider, adapters);
      if (!adapter) {
        return { status: 'unavailable', reason: `unknown judgment provider '${provider}'` };
      }
      if (Date.now() < openUntil) {
        return { status: 'unavailable', reason: `breaker open (opens again in ${openUntil - Date.now()}ms)` };
      }
      // Contract-level timeout: adapters own their wire timeouts; this guards
      // against an adapter that never resolves.
      const timeoutMs = Number(c.timeout_ms ?? 5000);
      const result = await Promise.race([
        Promise.resolve(adapter.judge(questions)),
        new Promise((resolve) => setTimeout(() => resolve({ status: 'unavailable', reason: `judge timeout after ${timeoutMs}ms` }), timeoutMs)),
      ]);
      if (result && result.status === 'ok') {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= Number(c.breaker_threshold ?? 3)) {
          openUntil = Date.now() + Number(c.breaker_cooldown_ms ?? 60000);
          consecutiveFailures = 0;
        }
      }
      return result;
    } catch (e) {
      // THE guarantee: even a broken adapter/adapter-registry can only ever
      // produce an unavailable result. Nothing above can throw past this line.
      consecutiveFailures += 1;
      if (consecutiveFailures >= Number(c.breaker_threshold ?? 3)) {
        openUntil = Date.now() + Number(c.breaker_cooldown_ms ?? 60000);
        consecutiveFailures = 0;
      }
      return { status: 'unavailable', reason: `judge error contained: ${e.message}` };
    }
  }

  return { provider: providerName(), probe, judge };
}

module.exports = { createJudge, pickAdapter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/judgment-index.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/judgment/index.js test/judgment-index.test.js
git commit -m "feat(judgment): createJudge — registry, timeout, circuit breaker, never-throw guarantee"
```

---

### Task 8: Provider-neutral goldens — replay infrastructure

**Files:**
- Create: `test/judgment-goldens/dream-supersession.json`
- Create: `test/judgment-goldens/autosave-classify.json`
- Test: `test/judgment-goldens.test.js`

These seed goldens ARE the future provider-switch acceptance test (spec §2 G3, §11.2).
Each golden: `{surface, questions, expected, policy:{threshold, expectBlocked, expectWarned}}`.

- [ ] **Step 1: Write the golden files**

```json
{
  "surface": "dream",
  "name": "dream-supersession",
  "policy": { "threshold": 0.6, "expectBlocked": ["sup-1"], "expectWarned": [] },
  "questions": [
    {
      "id": "sup-1",
      "judgment": { "kind": "probability", "claim": "Memory #12 (v1 auth flow) is fully superseded by memory #48 (v2 auth flow)" },
      "instructions": "Decide whether the first memory is fully superseded — nothing unique remains — by the second. Answer p = probability of full supersession.",
      "state": {
        "memory_a": { "id": 12, "title": "Auth flow v1 — session cookie design", "content": "**What**: session cookie flow… **Why**: single-host…" },
        "memory_b": { "id": 48, "title": "Auth flow v2 — session cookie + CSRF redesign", "content": "**What**: replaces v1 session cookie flow with… **Why**: CSRF hardening…" }
      }
    }
  ],
  "expected": [{ "id": "sup-1", "p": 0.95, "confidence": 0.9 }]
}
```

```json
{
  "surface": "autosave",
  "name": "autosave-classify",
  "policy": { "threshold": 0.6, "expectBlocked": [], "expectWarned": [] },
  "questions": [
    {
      "id": "msg-1",
      "judgment": { "kind": "classify", "enum": ["decision", "bugfix", "discovery", "pattern", "nothing"], "dangerous": "nothing" },
      "instructions": "Classify this assistant message for persistent-memory saving. 'nothing' means it is not worth saving. Marking real content as nothing is the dangerous outcome.",
      "state": { "message": "Chose vitest over node:test because mutation-score diffing needs per-file filtering." }
    }
  ],
  "expected": [{ "id": "msg-1", "pick": "decision", "confidence": 0.88 }]
}
```

- [ ] **Step 2: Write the failing replay test**

```js
// test/judgment-goldens.test.js
// Provider-neutral golden replay (spec §11.2): validates golden shape, runs the
// PURE pipeline (contract → evaluate) on expected answers, and shape-checks the
// jev translation — all with NO network. A future provider passes these same
// files through its adapter; that is the switch acceptance run.
// vitest globals are enabled (house style); do not import vitest
const fs = require('fs');
const path = require('path');
const { assertValidQuestion, assertValidAnswers } = require('../src/judgment/contract');
const { evaluate } = require('../src/judgment/evaluate');
const { buildWireQuestion } = require('../src/judgment/adapters/jev');

const GOLDEN_DIR = path.join(__dirname, 'judgment-goldens');
const goldens = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).map((f) => ({
  file: f,
  golden: JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf-8')),
}));

describe('judgment goldens replay', () => {
  it('has at least the two seed goldens', () => {
    expect(goldens.length).toBeGreaterThanOrEqual(2);
  });

  for (const { file, golden } of goldens) {
    it(`${file}: questions valid, expected answers valid, policy outcome matches`, () => {
      expect(golden.surface).toBeTruthy();
      for (const q of golden.questions) expect(() => assertValidQuestion(q)).not.toThrow();
      expect(() => assertValidAnswers(golden.questions, golden.expected)).not.toThrow();
      const pol = golden.policy;
      const outcome = evaluate({ questions: golden.questions, answers: golden.expected, threshold: pol.threshold });
      expect(outcome.blocked.map((b) => b.id).sort()).toEqual([...(pol.expectBlocked || [])].sort());
      expect(outcome.warned.map((w) => w.id).sort()).toEqual([...(pol.expectWarned || [])].sort());
    });
    it(`${file}: every question translates to a valid wire question (no throw)`, () => {
      for (const q of golden.questions) expect(() => buildWireQuestion(q)).not.toThrow();
    });
  }
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run test/judgment-goldens.test.js`
Expected: PASS (5 tests: 1 + 2 per golden).

- [ ] **Step 4: Commit**

```bash
git add test/judgment-goldens test/judgment-goldens.test.js
git commit -m "test(judgment): provider-neutral goldens (dream-supersession, autosave-classify) + replay"
```

---

### Task 9: Docs — `docs/JUDGMENT.md`

**Files:**
- Create: `docs/JUDGMENT.md`

- [ ] **Step 1: Write the doc**

```markdown
# Judgment Layer (`src/judgment/`)

Provider-agnostic semantic judgments for LaPis. **Default: OFF** — LaPis stays
zero-cloud/zero-keys unless you explicitly opt in.

## How it works

Call sites ask `judge(questions, {surface})`. The result is ALWAYS one of:

- `{status:'ok', answers}` — typed answers with confidence
- `{status:'unavailable', reason}` — off / no key / timeout / breaker open → **caller falls back to its heuristic**
- `{status:'invalid', reason}` — malformed provider reply (never crashes)

`judge()` never throws. Host flows can never block on judgment failure.

## Providers

| Provider | Config value | Needs |
| --- | --- | --- |
| Heuristic (default) | `LAPIS_JUDGE_PROVIDER=heuristic` | nothing — all fallbacks |
| TypeSafe Jev | `LAPIS_JUDGE_PROVIDER=jev` | machine-scoped `TYPESAFE_API_KEY` (never in project .env) |

## Flag matrix

| Flag | Default | Effect |
| --- | --- | --- |
| `LAPIS_JUDGE_PROVIDER` | `heuristic` | `heuristic` \| `jev` \| `off` |
| `LAPIS_JUDGE_TIMEOUT_MS` | `5000` | contract-level timeout per judge call |
| `LAPIS_JUDGE_LOCAL_ONLY` | `0` | kill switch — force heuristic path everywhere |
| `LAPIS_JUDGE_DISABLE_<SURFACE>` | unset | per-surface opt-out (e.g. `LAPIS_JUDGE_DISABLE_DREAM=1`) |
| `LAPIS_JUDGE_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | jev adapter endpoint (tests inject, never module-level) |
| `LAPIS_JUDGE_MODEL` | `jev-latest` | jev model id |
| `TYPESAFE_API_KEY` | — | jev auth; machine-scoped (`~/.zshenv`), read from process.env only |

## Surfaces & egress (what leaves the machine, per provider call)

| Surface | Status | State sent |
| --- | --- | --- |
| `dream` — Dream Cycle supersession/corrections | wired in Slice 1 | memory titles + first ~500 chars of content, candidate pairs |
| `autosave` — decision auto-detection | wired in Slice 2 | the assistant message text |
| `dedupe` / `guard` / `recall` / `trust` / `context` | not wired (later slices) | — |

`LAPIS_JUDGE_LOCAL_ONLY=1` guarantees zero egress regardless of provider config.

## Provider switching (goldens)

`test/judgment-goldens/*.json` are provider-neutral. A new adapter must replay
them: `npx vitest run test/judgment-goldens.test.js` plus the adapter's own wire
tests, then a live acceptance run (`LAPIS_JUDGE_LIVE=1`). Goldens measure the new
provider — they are the switch acceptance test, not a formality.
```

- [ ] **Step 2: Commit**

```bash
git add docs/JUDGMENT.md
git commit -m "docs(judgment): flag matrix, egress table, provider-switch runbook"
```

---

### Task 10: Full verification + spec acceptance (§13)

**Files:** none (verification only)

- [ ] **Step 1: Zero-key, zero-network guarantee**

```bash
env -i PATH="$PATH" HOME="$HOME" npx vitest run test/judgment-contract.test.js test/judgment-internal.test.js test/judgment-evaluate.test.js test/judgment-heuristic.test.js test/judgment-jev.test.js test/judgment-index.test.js test/judgment-config.test.js test/judgment-goldens.test.js
```
Expected: all PASS with no network access and no TYPESAFE_API_KEY.

- [ ] **Step 2: Lint + format + full suite**

```bash
npm run check && npm test
```
Expected: oxlint clean, oxfmt clean, full vitest suite green (pre-existing failures, if any, must be unrelated — verify with `git stash` if in doubt).

- [ ] **Step 3: Spec §13 checklist**

- [x] zero TypeSafe imports outside `adapters/jev.js` — verify: `grep -rl "typesafe" src/ --include="*.js"` returns only `src/judgment/adapters/jev.js`
- [x] default = heuristic; suite green with no key (Step 1)
- [x] wire tests ungated (test/judgment-jev.test.js)
- [x] polarity only via `evaluate.js` (unit-tested, no fakes)
- [x] goldens replay green
- [x] `docs/JUDGMENT.md` exists with flag matrix + egress table

- [ ] **Step 4: Commit (if anything was touched) and finish**

```bash
git status --porcelain   # expect clean
```

---

## Out of scope (deliberately NOT in this plan)

- Slice 1 (Dream Cycle wiring in `src/memory-domain/compaction.js` `dream()`) and
  Slice 2 (`extensions/memory-layer/hooks/pattern-matcher.ts` cascade) — separate
  plans, each building on this slice's stable seam.
- Second provider adapter — interface-only agnosticism per spec §3.
- Any destructive gating — advisory-only everywhere (spec §3).
