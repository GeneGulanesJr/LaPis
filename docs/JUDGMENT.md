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

## Module map

| File | Responsibility |
| --- | --- |
| `src/judgment/contract.js` | LaPis-owned types; boundary validators (`assertValidQuestion`, `assertValidAnswers`) |
| `src/judgment/internal.js` | shared kernel: `normalizeScore`, `band`, `capText`, `chunk`, single `CONFIDENT_THRESHOLD` |
| `src/judgment/evaluate.js` | pure policy evaluation — the ONLY place dangerous-answer polarity is interpreted |
| `src/judgment/index.js` | `createJudge()`: registry, contract timeout, circuit breaker, never-throw guarantee |
| `src/judgment/adapters/heuristic.js` | default provider — always `unavailable` |
| `src/judgment/adapters/jev.js` | TypeSafe System One wire adapter (the only file that knows Jev) |

Design spec: `docs/superpowers/specs/2026-09-26-jev-judgment-layer-design.md`.
