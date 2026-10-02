# Jev-driven compaction

> **Status:** off by default. Opt-in per machine, per project, or per session.

Jev-driven compaction is an alternative to pi's built-in context compaction. Instead of asking the LLM to summarize the whole old span as a single holistic summary, it asks a **judgment model** (Jev by default — replaceable) to decide **per message** whether to keep verbatim, summarize, or drop. The compaction summary is then assembled from those per-message decisions.

This doc covers:

1. [What it is](#what-it-is)
2. [Why](#why)
3. [How it works](#how-it-works)
4. [Enable](#enable)
5. [Replace the judger](#replace-the-judger)
6. [Cut-point rules](#cut-point-rules)
7. [Performance](#performance)
8. [Troubleshooting](#troubleshooting)
9. [Companion to Jev post-compact](#companion-to-jev-post-compact)

---

## What it is

Pi's built-in compaction calls the LLM once per compaction pass with a fixed structured prompt and produces a single summary that replaces the dropped span. That summary is good, but it is **holistic**. If a message in the dropped span mattered — a decision, a constraint, a rare fact — the LLM has to notice it inside a long concatenation.

Jev-driven compaction inverts that: **before** the summary LLM call, a small judgment model scores each candidate message on a 4-level scale:

| Level | Verdict | Meaning |
|------:|--------:|---------|
| 0 | `drop` | No value to the LLM beyond what the summary carries. |
| 1 | `summarize` | Gist belongs in the compaction summary. |
| 2 | `keep-verbatim` | Full message text is needed in the kept span. |
| 3 | `keep-with-tools` | Keep AND retain tool results / tool calls for this turn. |

Then the planner:

1. Walks the verdicts and enforces [pi's cut-point rules](#cut-point-rules) (tool calls must stay attached to tool results).
2. Assembles a custom summary from the kept messages (verbatim) plus a rollup of the dropped/summarized ones.
3. Returns it to pi via the `session_before_compact` hook.

---

## Why

Three reasons:

1. **Faithfulness.** Per-message decisions recover individual decisions and citations that a holistic summary loses.
3. **Replaceability.** The judgment is a strategy (`CompactionJudg`). Default is Jev (cheap, calibrated, `~43ms/judgment`). Swap it for any other decision function without touching the planner.
5. **Companion to Jev post-compact.** The memory-layer extension already runs **Jev post-compact C+A** (see [`docs/JUDGMENT.md`](./JUDGMENT.md)) to catch what was dropped *after* compaction. Jev-driven compaction closes the loop: Jev decides *before*, then validates *after*.

---

## How it works

```
turn_end (or before prompt)
    │
    ▼
session_before_compact event
    │
    │  gates (see "Enable" below):
    │   - compaction.judg / PI_COMPACTION_JUDG must be set
    │   - strategy must resolve
    │   - tokensBefore >= compaction.judgThresholdTokens (default 100_000)
    │     OR reason === "manual"
    │
    ▼
Resolve CompactionJudg:
   1. registry lookup ("jev", "default", "noop", or user-registered)
   2. fall through to file-path resolution (compaction.judgPath)
   3. fall through to NoopCompactionJudg (always returns verdict=1)
    │
    ▼
Per-message judgment (parallel, Jev score question per message)
    │  Each message → KeepVerdict + confidence
    │
    ▼
enforceCutPointRules():
   - tool-result keep forces preceding tool-call keep
   - tool-call keep forces next tool-result keep
   - keep-with-tools (3) requires both sides verbatim
    │
    ▼
assembleSummary():
   - previous summary (if any)
   - "Step decisions" header with verdicts counts
   - file operations (read/modified lists)
   - <keep> blocks for verbatim-kept messages
    │
    ▼
return { compaction: { summary, firstKeptEntryId, tokensBefore, details } }
```

When the gates don't pass, the handler returns `undefined` and pi's default compaction runs unchanged.

---

## Enable

Three opt-in surfaces (settings win over env unless the env explicitly sets a flag):

### Settings JSON (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`)

```jsonc
{
  "compaction": {
    "enabled": true,                  // keep pi default on
    "judg": "jev",                    // ← NEW, default unset = feature OFF
    "judgThresholdTokens": 100000,    // ← NEW, default 100_000
    "judgPath": "./my-judg.mjs",      // ← NEW, optional, overrides `judg`
    "judgDryRun": false               // ← NEW, mirrors JEV_DRY_RUN for the strategy
  }
}
```

### Env (for per-session opt-in without editing settings)

```bash
PI_COMPACTION_JUDG=jev                  # strategy name OR
PI_COMPACTION_JUDG_PATH=./my-judg.mjs   # file path
PI_COMPACTION_JUDG_ENABLED=1            # convenience gate
PI_COMPACTION_JUDG_THRESHOLD=100000     # threshold
PI_COMPACTION_JUDG_DRY_RUN=1            # dry-run (no live calls)
JEV_COMPACTION_ENABLED=1                # alias for PI_COMPACTION_JUDG_ENABLED
```

### Per-project

Drop a `.pi/settings.json` into the project root. The merged settings object the planner reads will see project settings overriding user settings.

---

## Replace the judger

Two ways to swap the Jev strategy for something else.

### 1. In-code: `registerCompactionJudg()` from another extension

```ts
import { registerCompactionJudg, type CompactionJudg } from '@gulaneskorp/lapis-memory-layer/host/compaction-judg';

class LocalLlmJudg implements CompactionJudg {
  readonly name = 'local-llm';

  async decideKeep(input) {
    const prompt = `Score 0..3 how to handle this message in compaction.\n${input.message.text}`;
    const score = await myLocalLlm.score(prompt);
    return { verdict: clamp(score), confidence: 0.9, reason: `local-llm:${score}` };
  }
}

registerCompactionJudg('local-llm', new LocalLlmJudg());
```

Then set `"compaction.judg": "local-llm"` in settings.

### 2. Settings-only: file path

Write a module that default-exports a `CompactionJudg`:

```js
// ~/.pi/judgers/haiku-judg.mjs
export default {
  name: 'haiku',
  async decideKeep(input) {
    const text = input.message.text ?? '';
    const verdict = text.length < 50 ? 0 : 1;
    return { verdict, confidence: 0.7, reason: 'length-based heuristic' };
  },
};
```

Then set `"compaction.judgPath": "/Users/you/.pi/judgers/haiku-judg.mjs"`.

---

## Cut-point rules

Per [`docs/compaction.md`](./compaction.md) §"Cut Point Rules":

> Valid cut points are: User messages, Assistant messages, BashExecution messages, Custom messages. Never cut at tool results (they must stay with their tool call).

The planner enforces these rules in two passes after the verdicts come back:

| Situation | Forced action |
|-----------|---------------|
| Tool-result `verdict >= 2` | Promote preceding assistant tool-call to `keep-verbatim` |
| Tool-call assistant `verdict >= 2` | Promote next tool result to `keep-verbatim` |
| `keep-with-tools` (3) on any message | Promote both neighbors to `keep-verbatim` |

If you set `judgment: "default"` or `"noop"`, the planner never runs and pi's built-in cut-point logic applies normally.

---

## Performance

- **Latency per judgment:** ~43-45ms (live, per the Jev wire discovery).
- **Batch parallelization:** all per-message judgments run in parallel via `Promise.all`. For 50 candidate messages, total planner latency is ~50ms + serialization overhead, not 50 × 50ms.
- **Failure mode:** any `decideKeep()` throw is caught and treated as `summarize` (verdict=1). Compaction never blocks on a strategy failure.
- **Overflow recovery:** when `reason === "overflow"`, the planner explicitly defers to pi's built-in path. Jev-driven summaries may not complete in time inside the recovery window, so we don't try.

---

## Troubleshooting

### "I set `compaction.judg: "jev"` but nothing happens"

- Check that **both** `JEV_ENABLED=1` and `JEV_API_KEY` (or `TYPESAFE_API_KEY`) are set. The Jev strategy reuses the existing Jev client; if those gates fail, every judgment falls through to `summarize`.
- Check `compaction.judgDryRun: true` and re-run. You should get `<keep>` blocks in the wrap for **every** message — if not, your config isn't being merged into the settings object.
- Verify the settings.json file is being parsed. A syntax error silently drops the entire settings block; the planner then reads `undefined` and stays off.

### "Verdicts look wrong"

- Set `PI_COMPACTION_JUDG_DRY_RUN=1` (or `JEV_DRY_RUN=1`) to bypass the LLM and use canned answers. The strategy should always return `verdict=1` in that mode.
- Inspect `details.verdicts` in the `CompactionEntry` for confidence scores. Low-confidence verdicts are likely uncertain judgments.

### "Compaction is slower"

- Jev latency is bounded by `JEV_TIMEOUT_MS` (default 8s). If a session is hitting timeouts, drop the threshold higher (e.g. 200k tokens) so the planner runs less often.

---

## Companion to Jev post-compact

The memory-layer extension already ships a post-compact C+A integration on `session_compact`:

- **C** (reclassify): re-classify the re-injected slice against pinned policies from `AGENTS.md`. Catches dropped policy citations.
- **A** (verdict): score how completely the re-injected slice covers lost topics. Catches dropped decisions.

With Jev-driven compaction, the loop closes:

```
   ┌──── per-message verdicts (this doc)
   │
   ▼
compaction summary
   │
   ▼
   ┌──── post-compact C+A (existing)
   │
   ▼
  re-injected memory slice
```

Both integrations share the same `JEV_ENABLED`/`JEV_API_KEY` gates and the same dry-run mode. Both fail-open (return empty/noop) on any strategy failure so they never block pi's compaction flow.

---

## API reference

See [`extensions/memory-layer/host/compaction-judg.ts`](../extensions/memory-layer/host/compaction-judg.ts) for the full `CompactionJudg` interface and registry.