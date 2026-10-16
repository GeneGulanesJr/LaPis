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
| Liquid AI Decisions API | `LAPIS_JUDGE_PROVIDER=decision` | machine-scoped `LIQUID_API_KEY` (never in project .env) |

`provider: 'jev'` (the pre-rename name) is still read as `decision` for one
release — a deprecated alias for existing configs; switch to `decision`.

## Flag matrix

| Flag | Default | Effect |
| --- | --- | --- |
| `LAPIS_JUDGE_PROVIDER` | `heuristic` | `heuristic` \| `decision` \| `off` |
| `LAPIS_JUDGE_TIMEOUT_MS` | `5000` | contract-level timeout for a judge built directly with `createJudge()` (scripts; also read by the decision adapter as its wire timeout, which falls back to 8000 when unset). The surfaces below use `surface_timeout_ms` / `prompt_filter_timeout_ms` instead |
| `judgment.surface_timeout_ms` (config) / `LAPIS_JUDGE_SURFACE_TIMEOUT_MS` | `2000` | cap on each request of the `recall`, `dedupe`, `trust`, `guard`, `autosave` and `dream` surfaces — contract race AND wire abort, no wire retries |
| `LAPIS_JUDGE_MAX_RETRIES` | `2` | decision adapter wire retries per call (scripts only — every surface sends ONE attempt) |
| `LAPIS_JUDGE_LOCAL_ONLY` | `0` | kill switch — force heuristic path everywhere (every surface off: no request, no log line) |
| `LAPIS_JUDGE_DISABLE_<SURFACE>` | unset | per-surface opt-out (e.g. `LAPIS_JUDGE_DISABLE_DREAM=1`; same as `judgment.disables.<surface>: true` in config) |
| `LAPIS_JUDGE_ENDPOINT` | `https://api.liquid.ai/decisions/v1/systemone` | decision adapter endpoint (tests inject, never module-level) |
| `LAPIS_JUDGE_MODEL` | `d1-ultra` | decision model id: `d1-ultra` or `d1` (same latency in testing, about half the cost) |
| `LIQUID_API_KEY` | — | decision auth; machine-scoped (`~/.zshenv`), read from process.env only |
| `LAPIS_JUDGE_LOG` | `~/.pi/memory/judgment.log` | where every surface writes one JSON line per judged call (next to the configured memory DB); `0` turns the log off |
| `judgment.prompt_filter_threshold` (config) | `0.5` | prompt filter: a candidate is injected when its judged relevance probability is at least this |
| `judgment.prompt_filter_timeout_ms` (config) | `2000` | prompt filter: cap on its one request (wire timeout, no retries); also used by the gateway `context` selection |

## Surfaces & egress (what leaves the machine, per provider call)

| Surface | Status | State sent |
| --- | --- | --- |
| `dream` — Dream Cycle supersession/corrections | wired (Slice 1) | memory titles + first ~400 chars of content, candidate pairs |
| `autosave` — decision auto-detection | wired (Slice 2) — Pi passive capture | the assistant message text (first 4000 chars) |
| `recall` — semantic search rerank | wired (Slice A) | the query + top-N (default 10) ranked rows: id, title, first ~400 chars of snippet/content |
| `dedupe` — duplicate verification | wired (Slice D) | existing memory id/title + first ~400 chars of content, incoming title + first ~400 chars |
| `trust` — invalidation review | implemented (Slice E), caller wiring pending | memory id + title (~120 chars), changed symbol names (up to 20) |
| `guard` — command classify cascade | wired (Slice F) — `lapis run`, unmatched commands only | the bash command text (first 500 chars) |
| `context` — context selection | wired | the task (first ~400 chars) + per-candidate id/title/type and first ~300 chars of content |
| `context` — Claude Code prompt filter (`UserPromptSubmit`) | wired | the prompt (first 2000 chars) + per candidate: memory title (~160 chars), type and the injected ~280-char snippet; cross-project suggestion title/type/project; preflight symbol, kind, file path and signature (~200 chars); related file paths |

`LAPIS_JUDGE_LOCAL_ONLY=1` guarantees zero egress regardless of provider config.

### When each surface runs, what it costs, how it fails

Every surface builds its judge through `src/judgment/surface.js` (`buildSurfaceJudge`), which returns the judge
FUNCTION. Until 2026-10-16 four surfaces (`recall`, `dedupe`, `trust`, `guard`) and the Pi auto-save hook built the
`createJudge()` OBJECT and called it as a function: every live call threw inside the surface's `try`/`catch` and
fell back silently, with no request made (`context` had the same bug, fixed in #368). `test/judgment-surfaces-wire.test.js`
runs every surface through the real builder with only `fetch` stubbed.

A surface runs only when `provider: "decision"`, `LIQUID_API_KEY` is set, `local_only` is off and the surface is not
disabled. Each request is capped (contract race + wire abort) with no retries; a timeout, an HTTP or network error, a
malformed reply or an exception gives exactly the non-judgment result. Latency: Liquid d1-ultra, 2026-10-16, 20 live
calls per surface.

| Surface | Runs | Requests | Added latency (median / p90) | Falls back to | Writes? |
| --- | --- | --- | --- | --- | --- |
| `recall` | every `search` dispatch with results: CLI `search`, the `memory-search` MCP tool (Claude Code) and Pi tool | 1 (top 10 rows) | 0.46 s / 0.51 s (10 rows); 0.41 s / 0.62 s (3 rows) | the lexical order | no — reorders rows, adds `decision` |
| `dedupe` | a `save` that stops at `potential_duplicate` (trigram 0.6–0.85; at most 3 matches) | 1 | 0.38 s / 0.49 s | no `decisionVerified` field | no — annotation only; the trigram auto-merge (≥ 0.85) never consults the judge |
| `trust` | nothing calls it yet | 1 per 10 links | 0.38 s / 0.62 s (direct call) | `unavailable` | no |
| `guard` | `lapis run <command>`, before the command, only when no `COMMAND_RULES` regex matched | 1 | 0.37 s / 0.53 s | the sync type (`generic`) | no — picks the output compressor |
| `autosave` | Pi `message_end`, assistant messages ≥ 150 chars that the regex missed, outside the save cooldown | 1 | 0.36 s / 0.47 s | the regex result | **yes** — a confident pick (≥ 0.6, not `nothing`) saves an auto-decision memory, as Slice 2 documents |
| `dream` | the gateway `dream` command (Pi: once per session at turn 50; `scripts/cleanup-sessions.js`) | 1 per 10 candidates | 0.37 s / 0.51 s per request | `unavailable` in the report | no — annotates `dreamDecisionReview`; dream's own deletions do not read it |
| `context` | see the prompt filter below and the gateway `context` selection | 1 per 10 candidates | see below | the builder's selection | no |

Cap: `judgment.surface_timeout_ms` (2000 ms; `context`: `prompt_filter_timeout_ms`). The breaker
(`breaker_threshold` failures → `breaker_cooldown_ms` off) lives in one judge instance: Pi's auto-save keeps one per
process and a dream review one per run; the other surfaces build one per call, so during an outage each call pays at
most one capped request.

Each judged call appends one line to the judgment log (`LAPIS_JUDGE_LOG`): `{ts, surface, status, n, ms}` plus
`levels` (recall, gateway context: memory id + level), `p` (dedupe, trust, dream: memory id + probability) or
`pick`/`confidence`/`used` (guard, autosave), and `reason` on a failure. No memory, message, prompt or command text.

### Claude Code prompt filter

The `UserPromptSubmit` hook injects up to three lexically matched lists: Prompt-Matched Memory,
Cross-Project Suggestions and Preflight code entries. With `provider: "decision"` and `LIQUID_API_KEY`
set (and `context` not disabled), `src/claude-code/prompt-filter.js`:

1. drops preflight and coding-context entries whose file is not on disk (a code index built on another
   machine points at paths that do not exist here) — no network;
2. sends ONE request (`judgePromptRelevance` in `src/memory-domain/context-decision.js`) with a `noul`
   question per remaining candidate — "`candidate_i` is about the same subject as `prompt` and would help
   answer it" — and keeps the candidates with p ≥ `prompt_filter_threshold` (0.5). The memory slot is
   filled with the first kept memory, so a relevant memory ranked second can replace an irrelevant first;
   a section left empty is omitted.

The gateway's own per-memory selection is skipped for that dispatch (`'decision-select': 'off'`), so a
prompt makes one request. Tuning data from 2026-10-16 (d1-ultra, 10 real prompts): irrelevant candidates
scored 0.001–0.31, relevant ones 0.52–0.99. Median added latency about 0.55 s per prompt (request
400–700 ms); on preflight prompts the hook can be faster, because a dropped preflight target skips the
coding-context dispatch.

Fail open: a timeout (`prompt_filter_timeout_ms`, 2 s, no retries), an HTTP or network error, a malformed
reply or any exception renders exactly the unfiltered output. Off (`LAPIS_JUDGE_DISABLE_CONTEXT=1`, another
provider, no key) is the old code path: no request, no extra dispatch argument, no log line.

Each filtered prompt appends one JSON line to `LAPIS_JUDGE_LOG` (default `~/.pi/memory/judgment.log`):
status, threshold, the number of missing paths dropped, kept/dropped counts per kind, each candidate's kind,
memory id and probability, and the latency. It holds no memory text and no prompt text.

## Provider switching (goldens)

`test/judgment-goldens/*.json` are provider-neutral. A new adapter must replay
them: `npx vitest run test/judgment-goldens.test.js` plus the adapter's own wire
tests, then a live acceptance run against the real endpoint. Goldens measure the new
provider — they are the switch acceptance test, not a formality.

## Live wire shapes (verified on Liquid 2026-10-16)

Request: `POST https://api.liquid.ai/decisions/v1/systemone`, `Authorization: Bearer $LIQUID_API_KEY`,
body `{model, state, questions}` with `questions` an object keyed by id.

- `noul` replies: `{type, noul}` — **confidence omitted** → adapter derives it as `|p−0.5|×2`
- `score` replies: **float** position (e.g. `1.82`) + `legend` + `probabilities` + `confidence` → adapter rounds to nearest level index
- `choice` replies: `{type, choice, confidence, probabilities}` — as expected
- `usage`: `{input_tokens, output_tokens, cost}`

Wire limits (HTTP 422 `invalid_request_error`, `error.param` names the field):

- a `choice` needs **at least 2 options** — the adapter answers a one-option
  classify locally (pick = the option, confidence 1) and never sends it; a
  request whose questions are all one-option makes no call
- a `score` takes 2–10 levels; a request takes at most 128 questions
- each question's prompt (instructions + state) is capped at 32,768 tokens or
  250,000 bytes; empty `instructions` are rejected
- errors come back as `{error: {message, type, param, code}}` (401
  `authentication_error`, 404 `not_found_error` for an unknown model, 422
  `invalid_request_error`); a malformed body is a plain-text 400

## Compaction integration

The same judgment primitives power the **Decision-driven compaction** feature in
`extensions/memory-layer/`. It uses a `CompactionJudg` strategy to score each
candidate message before summarization (verdict = drop / summarize /
keep-verbatim / keep-with-tools) and assembles a custom summary from those
per-message decisions. The post-compact C+A integration in
`extensions/memory-layer/hooks/decision-post-compact.ts` then validates the
re-injected slice against pinned policies and lost topics — closing a
decides-in / validates-out loop. Both extension features share
`DECISION_ENABLED` / `DECISION_DRY_RUN` / `LIQUID_API_KEY` gating (the `src/judgment` surfaces
above gate on `LAPIS_JUDGE_PROVIDER=decision` + `LIQUID_API_KEY` instead) and the
never-throw guarantee. **Off
by default.** See [`DECISION_DRIVEN_COMPACTION.md`](./DECISION_DRIVEN_COMPACTION.md).

## Module map

| File | Responsibility |
| --- | --- |
| `src/judgment/contract.js` | LaPis-owned types; boundary validators (`assertValidQuestion`, `assertValidAnswers`) |
| `src/judgment/internal.js` | shared kernel: `normalizeScore`, `band`, `capText`, `chunk`, single `CONFIDENT_THRESHOLD` |
| `src/judgment/evaluate.js` | pure policy evaluation — the ONLY place dangerous-answer polarity is interpreted |
| `src/judgment/index.js` | `createJudge()`: registry, contract timeout, circuit breaker, never-throw guarantee |
| `src/judgment/adapters/heuristic.js` | default provider — always `unavailable` |
| `src/judgment/adapters/decision.js` | Liquid AI Decisions API wire adapter (the only file that knows the provider wire) |
| `src/judgment/surface.js` | `buildSurfaceJudge` (the judge FUNCTION, capped, no retries) + `surfaceEnabled` — every surface goes through it |
| `src/judgment/log.js` | the judgment log writer (one JSON line per judged call) |
| `src/memory-domain/search-decision.js` | surface `recall`: search rerank |
| `src/memory-domain/dedupe-decision.js` | surface `dedupe`: duplicate verification annotation |
| `src/trust-sync/trust-decision.js` | surface `trust`: invalidation review (no caller yet) |
| `src/token-saver/classify-decision.js` | surface `guard`: `lapis run` command classification |
| `src/hooks-engine/autosave-judge.js` | surface `autosave`: the judge Pi passive capture hands to `shouldAutoCaptureWithJudge` |
| `src/memory-domain/dream-decision.js` | surface `dream`: dream candidate review |
| `src/memory-domain/context-decision.js` | surface `context`: gateway context selection + `judgePromptRelevance` |
| `src/claude-code/prompt-filter.js` | Claude Code prompt filter: path pre-filter, candidate assembly, threshold, judgment log |

Design spec: `docs/superpowers/specs/2026-09-26-jev-judgment-layer-design.md`.
