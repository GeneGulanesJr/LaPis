# Provider-Agnostic Judgment Layer (`src/judgment/`) — Design Spec

**Date:** 2026-09-26
**Status:** Approved design, pending implementation plan (Slice 0)
**Author:** brainstorming session (user + Pi)

---

## 1. Motivation

LaPis's intelligence today is entirely heuristic: FTS + recency + trust-weight scoring for
recall (`rankObservations`), title-trigram overlap for dedup (`checkDuplicate`), regex
arrays for decision auto-detection (`DECISION_PATTERNS`), regex command classification
(`COMMAND_RULES`), and SQL/regex phase heuristics in the Dream Cycle (`dream()`).

These work but have known ceilings: false-positive auto-saves, title-only dedup that
misses same-decision-different-words, and staleness detection that cannot tell
"superseded" from "old".

**System One models** (TypeSafe's **Jev** is the flagship) return fast, typed judgments —
classification picks, probabilities, graded scores — exactly the missing semantic layer.
They are cheap enough to run as advisors and never as authorities.

Prior art: the RetellMCP Jev integration (9 phases, complete — see memory #26775) proved
the wrapper/contract/golden-test discipline. Its 4-reviewer postmortem (memory #26800)
supplies the failure classes this design makes structurally impossible.

**User goals:** all surfaces eventually (memory quality, session efficiency, trust
intelligence), but provider-agnostic — Jev may be swapped for another provider that does
the same thing. V1 ships the interface + the Jev adapter only (no second adapter).

## 2. Goals

1. **G1 — Provider-neutral seam.** LaPis core never imports TypeSafe. Providers are
   adapters behind one interface; swapping = adding one adapter file + config value.
2. **G2 — Zero disruption when off.** Every judgment call site keeps its existing
   heuristic as fallback. Provider off / missing key / timeout / malformed reply →
   today's behavior, silently. Host flows can never block on judgment failure.
3. **G3 — Measurable switch.** Per-surface goldens stored provider-neutrally, replayable
   against any adapter, so a future provider swap is an acceptance run, not a hope.
4. **G4 — Slice order.** Dream Cycle staleness → decision auto-detection → (later)
   dedup, guard cascade, recall rerank, trust invalidation, context selection.

## 3. Non-goals (v1)

- No second provider adapter shipping (interface-only agnosticism; seam proven by tests).
- No hot-path judgment calls (recall rerank, guard cascade) — later slices only.
- No auto-enable: LaPis's identity is "one SQLite DB, zero cloud, zero API keys"
  (README). Judgments are strictly **opt-in**.
- No judgment-gated destructive actions, ever (RetellMCP contract rule, generalized).

## 4. Domain stress-test

| Tension | Resolution |
| --- | --- |
| "Zero cloud, zero API keys" ethos vs cloud judgment calls | **Default `LAPIS_JUDGE_PROVIDER=heuristic`** (judgments off). Jev requires explicit opt-in + key. This is stricter than RetellMCP (advisory-default) because LaPis ships as a public npm package. |
| Multi-host (Pi, Claude Code, Hermes) share one DB/CLI | The judgment layer lives in the shared core (`src/judgment/`), invoked by domain modules — not by host extensions. All three hosts benefit identically. |
| Egress of memory content | Per-surface egress documented in one flag matrix; `LAPIS_JUDGE_LOCAL_ONLY=1` forces heuristic path everywhere. State sent per surface is explicit (see §9). |
| Advisory-only discipline | Enforced structurally: `judge()` is a total function that never throws (§7); no call site can be blocked by a judgment failure. |

## 5. Architecture

```
src/judgment/                 ← new core module (provider-neutral)
  contract.ts                 ← judgment types, confidence semantics, advisory rule
  adapter.ts                  ← JudgeAdapter interface + capability metadata
  index.ts                    ← registry, config selection, timeout, circuit breaker
  evaluate.ts                 ← pure policy evaluation (polarity lives HERE)
  internal.ts                 ← shared kernel: band(), normalize(), capText(), chunk()
  adapters/
    jev.ts                    ← TypeSafe System One adapter (wire boundary = 1 file)
    heuristic.ts              ← always `unavailable`; makes "off" first-class + testable
```

Call sites (memory-domain, hooks, token-saver) import from `src/judgment` only — never
from `adapters/*`.

## 6. Core contract (LaPis-owned types)

```ts
type Judgment =
  | { kind: 'classify'; enum: readonly string[]; dangerous?: string }  // 'dangerous' = the answer value that means "unsafe/bad"
  | { kind: 'probability'; claim: string }                             // "is M superseded by M2?"
  | { kind: 'grade'; levels: readonly string[] }                       // ordered, low → high

interface Question {
  id: string                    // for code; NOT sent verbatim to the provider
  judgment: Judgment
  instructions: string          // complete meaning; self-contained
  state: Record<string, unknown> // named JSON fields; backtick-path refs allowed
}

interface Answer {
  id: string
  pick?: string                 // classify
  p?: number                    // probability, normalized 0..1
  level?: number                // grade index
  confidence: number            // 0..1, contract-level semantics (distribution concentration)
}

type Result =
  | { status: 'ok'; answers: Answer[] }
  | { status: 'unavailable'; reason: string }   // off, no key, timeout, breaker open
  | { status: 'invalid'; reason: string }       // malformed/failed validation
```

Rules:

- **R1 — LaPis owns the vocabulary.** No `Choice`/`Noul`/`Score` outside `adapters/jev.ts`.
  (Jev wire shape `{noul, confidence}` with no `value` field — memory #26674 — is an
  adapter-internal detail.)
- **R2 — Normalization at the boundary.** Adapters emit 0..1 floats only (the
  float-leak P2 from RetellMCP never reaches core).
- **R3 — Validation at the boundary.** Adapters validate provider replies before
  returning `status:'ok'`; malformed-OK responses become `invalid` (P1 #3 lesson).
- **R4 — Polarity is declarative.** A question's "dangerous" answer is declared in the
  contract; blocking/warning logic derives only through `evaluate.ts` pure functions.
  Call sites never compare raw answers against thresholds (P1 #1 lesson).

## 7. Failure policy (total-function guarantee)

`judge(batch): Promise<Result>` **never throws**. Implementation in `index.ts`:

- Config off or key missing → `unavailable` before any adapter call (P1 #2 lesson —
  no exception can reach a host path).
- Per-call timeout (default 5s, `LAPIS_JUDGE_TIMEOUT_MS`) → `unavailable`.
- Circuit breaker: 3 consecutive failures → open for 60s (both configurable); calls
  during open → `unavailable` without network.
- Host wiring wraps nothing in try/catch for judgment — there is nothing to catch.

## 8. Adapters

```ts
interface JudgeAdapter {
  readonly name: string
  probe(): Promise<Health>                       // cheap config/health check
  judge(batch: Question[]): Promise<Result>      // respects batch caps from capabilities
}
```

- **`adapters/jev.ts`** — TypeSafe System One. Translates `classify`/`probability`/`grade`
  → Choice/Noul/Score questions; validates replies; normalizes scores; maps provider
  errors to `unavailable`. The **only** file that changes if the wire changes.
- **`adapters/heuristic.ts`** — returns `unavailable` always. Selected by default config;
  makes "judgments off" an exercised, testable path rather than dead code.

## 9. Config, flags, egress

| Flag | Default | Meaning |
| --- | --- | --- |
| `LAPIS_JUDGE_PROVIDER` | `heuristic` | `heuristic` \| `jev` \| `off` |
| `LAPIS_JUDGE_TIMEOUT_MS` | `5000` | Per-call timeout |
| `LAPIS_JUDGE_LOCAL_ONLY` | `0` | Force heuristic path everywhere (kill switch) |
| `LAPIS_JUDGE_DISABLE_<SURFACE>` | `0` | Per-surface opt-out (e.g. `_DREAM`, `_AUTOSAVE`) |
| `LAPIS_JUDGE_ENDPOINT` | provider default | Injectable for tests — **never** read at module top level (the 16-failure env-leak lesson) |

Egress matrix (kept in `docs/JUDGMENT.md`): each surface lists exactly which fields go to
the provider (e.g. Dream: memory titles + first N chars of content + candidate superseder
title; Auto-save: the assistant message text). `LOCAL_ONLY` documented as the zero-egress
guarantee. One flag matrix, one home (P3 docs-drift lesson).

## 10. Integration surfaces (verified against source, 2026-09-26)

### Slice 1 — Dream Cycle staleness (offline batch, advisory)
**Where:** `src/memory-domain/compaction.js` → `dream()` (invoked via `services/dream.js`).
*(Correction from draft: NOT `src/agent-intel/stale-flags.js` — that module scans repo
code for always-true feature flags and is unrelated.)*

Phase mapping (cheap candidates → Jev verification, same cascade everywhere):

| dream() phase today | Jev upgrade |
| --- | --- |
| `superseded` (SQL-matched pairs) | `probability` Noul per pair: "is A superseded by B?" — clean only below threshold |
| `corrections` (regex `#(\d+)` refs) | `probability`: "does referenced correction invalidate this memory?" |
| `staleAutoTypes`, `obsoleteConfigs`, `noiseTitlePatterns` (hardcoded lists) | later: `classify` generalization — post-v1, not slice 1 |

Advisory only: Jev verdicts annotate the dream report; nothing is deleted on a judgment
alone in v1.

### Slice 2 — Decision auto-detection (pre-save classification)
**Where:** `extensions/memory-layer/hooks/pattern-matcher.ts` (`DECISION_PATTERNS` —
regex + type + `minConfidence`) fed by `session-lifecycle.ts` assistant messages.

Regex-first cascade: patterns matching with high confidence save immediately (unchanged);
no pattern match or borderline match → one `classify` call (decision/bugfix/discovery/
pattern/nothing). Result flows into the existing `minConfidence` gating. Cuts false-
positive auto-saves without adding latency to every message (only unmatched/borderline
ones incur a call).

### Later slices (design accommodates, not v1)
- **Dedup:** `src/memory-domain/dedupe.js` — trigram candidates already produced by
  `checkDuplicate`; Noul "same decision?" feeds the **existing** `markDuplicate`
  `confidence` param. Zero schema change.
- **Guard cascade:** `src/token-saver/classify-command.js` (`COMMAND_RULES`) — regex
  first, `classify` for ambiguous commands only.
- **Recall rerank:** `src/memory-domain/search.js` `rankObservations` — Jev `grade`
  over top-N lexical candidates.
- **Trust invalidation:** `src/trust-sync/trust-policy.js` — `probability` "does this
  diff invalidate memory M?" on symbol-linked pairs.
- **Context selection:** budget-constrained `grade` selection for injection packs.

## 11. Testing strategy

1. **Ungated wire tests** for every surface through a fake server (RetellMCP P1 #4 —
   the flagship module must never be dry-run-only).
2. **Provider-neutral goldens** per surface: recorded request/state → expected answer
   tuples, replayable against any adapter. A provider swap = `npm run judgment:acceptance`
   against the same goldens (this IS G3).
3. **Polarity unit tests** on `evaluate.ts` pure functions — no HTTP fakes (P1 #1:
   `strictVerdictFailures` pattern promoted to core).
4. **Total-function tests:** missing key, timeout, malformed 200, breaker open — every
   path returns `unavailable`/`invalid`, host flow proceeds.
5. **Hooks exported and injectable** (`{adapter, flags, clock}`) — real execution tests,
   no source-grep theater (P1 #5).
6. **Env hygiene:** `LAPIS_JUDGE_ENDPOINT` injected per-call in all test files.
7. **Live gated tests** behind `LAPIS_JUDGE_LIVE=1`, skipped by default in CI.

## 12. Shared kernel (day one, not deferred)

`internal.ts`: `band(p, thresholds)`, `normalizeScore(x)`, `capText(s, n)`,
`chunk(arr, n)`, single `CONFIDENT_THRESHOLD = 0.6`. One band convention — inclusive
lower bounds everywhere (P2 band-drift lesson). Prevents the ~180-line duplication the
RetellMCP review found at its 4th hook.

## 13. Acceptance criteria — Slice 0

- [ ] `src/judgment/` compiles into the core build; zero TypeSafe imports outside `adapters/jev.ts`
- [ ] Default config = heuristic; full test suite passes with no key present, no network
- [ ] Wire tests (fake server) for jev adapter: ok / malformed / timeout / missing-key
- [ ] Polarity evaluated only via `evaluate.ts`; unit tests cover dangerous-answer and inconclusive paths
- [ ] Goldens replay green against both `jev` and `heuristic` adapters (heuristic = all-unavailable path)
- [ ] `docs/JUDGMENT.md` with flag matrix + per-surface egress table

## 14. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Latency in hot paths | V1 surfaces are batch/offline (dream) or on-miss only (auto-save cascade) |
| Egress of private memory content | Default off; LOCAL_ONLY; egress matrix; surfaces send minimal fields |
| Provider drift (wire changes) | Contained to `adapters/jev.ts`; wire tests catch immediately |
| Confidence semantics differ across providers | Contract documents confidence as distribution-concentration; goldens measure, not assume |
| Scope creep into blocking decisions | R4 + advisory-only rule in contract; no destructive gating in v1 (or v2) |

## 15. Open questions

1. Should Slice 1's dream report render Jev flags in the TUI dashboard, or CLI output only? (CLI-only assumed)
2. Batch caps per provider call for the dream sweep (candidate pairs can number in the dozens) — cap at 10 per call?
3. Later: does `crosshash-ai` (Rust) ever need the same judgments, or does Rust call the TS CLI? (Out of scope; noted.)
