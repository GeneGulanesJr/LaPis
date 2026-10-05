# Benchmarks

## Token efficiency benchmark

`bench/bench-tokens.js` measures how much LaPis' compact wire format reduces analysis-response size. It runs real code-analysis CLI commands against an indexed repo, compares raw JSON with `compactResponse()` output, and prints per-tool and total byte savings.

Run against the current repo:

```bash
node bench/bench-tokens.js
```

Run against another indexed repo:

```bash
node bench/bench-tokens.js --repo-path /path/to/repo --repo-name RepoName
```

Force a fresh code index before measuring:

```bash
node bench/bench-tokens.js --reindex
```

Treat the output as a current local snapshot. Results change when the repo, indexer, code-analysis commands, or compact wire format changes.

## Pi paired memory benchmark

`bench/bench-pi-paired.js` measures memory-on and memory-off as real Pi runs. It does not simulate the no-memory case.

Run:

```bash
npm run bench:pi-paired
```

By default, the harness runs memory-off first with a temporary `HOME` that copies only Pi config/auth files, then runs memory-on with your normal Pi environment.

You can override the command templates:

- `BENCH_PI_MEMORY_OFF_CMD`: vanilla Pi, no LaPis extension, no injected memory context.
- `BENCH_PI_MEMORY_ON_CMD`: Pi with LaPis extension/skills available.

Both commands should use `--no-session` so previous chat history cannot leak between runs. The no-memory command should still be allowed to read/search the repo normally; it is not a blind agent.

Template variables:

- `{prompt}`: shell-quoted task prompt
- `{task_id}`: task id
- `{repo}`: repo name from the fixture
- `{out}`: shell-quoted output file path

Override example:

```bash
BENCH_PI_MEMORY_OFF_CMD='pi --print --mode json --no-session {prompt} > {out} 2>&1' \
BENCH_PI_MEMORY_ON_CMD='pi --print --mode json --no-session {prompt} > {out} 2>&1' \
node bench/bench-pi-paired.js
```

Results are written under `bench/results/` with one JSONL transcript per task/side and a `report.json` summary.

The default task pack lives at `bench/fixtures/pi-memory-tasks.json`. It intentionally mixes:

- `prior-decision`: memory should recover why something was chosen.
- `bug-history`: memory should recover the reason behind a fix.
- `staleness`: memory should warn/verify instead of blindly trusting old indexed facts.
- `navigation`: memory should jump to likely modules and then verify.
- `negative-control`: memory should not be necessary and should avoid adding overhead.

Each task has expected facts with aliases. The built-in grader is intentionally simple and deterministic; for publishable numbers, review misses manually or replace it with a stricter evaluator.

Use this benchmark as an internal regression and directional signal, not a comprehensive scientific evaluation. The harness is legitimate for comparing real memory-off and memory-on Pi runs because it records raw transcripts, structured reports, token usage, cache reads, elapsed time, tool counts, and expected-fact matches under `--no-session`. Its limits are that each side runs once, memory-off is vanilla Pi rather than a separately optimized retrieval baseline, memory-off always runs before memory-on by default, the grader is substring/alias based, and the task pack is intentionally small. For stronger external claims, add repeated runs, randomized side ordering, stricter/manual grading, and broader task coverage.

## Realworld Pi memory benchmark

`bench/realworld/bench-pi-realworld.js` runs Pi against real code-editing tasks and measures whether memory-on improves completion rate, reduces wrong turns, and preserves project decisions better than memory-off.

The benchmark has two tiers:

- **Long-horizon tasks** (in `tasks/`) — multi-file, multi-step tasks requiring 10-40+ tool calls. These test deep agentic reasoning, architectural awareness, and memory-guided decision-making.
- **Short regression tasks** (in `tasks/short/`) — single-focus tasks for basic regression coverage.

Run:

```bash
npm run bench:pi-realworld
```

By default, the harness:

1. Creates a fresh git worktree for each run
2. Applies bug-injection patches to introduce failures
3. Runs Pi with the task prompt (memory-off first, then memory-on)
4. Grades results on six axes: tests pass, diff touches correct files, answer contains expected facts, trajectory quality, semantic constraints, and precision
5. Repeats each task 3 times for statistical signal

Options:

```bash
# More repetitions
node bench/realworld/bench-pi-realworld.js --runs 5

# Single task for debugging
node bench/realworld/bench-pi-realworld.js --only bugfix-createdb-config

# Only long-horizon tasks
node bench/realworld/bench-pi-realworld.js --only-long

# Only short regression tasks
node bench/realworld/bench-pi-realworld.js --only-short

# Filter by category
node bench/realworld/bench-pi-realworld.js --category cross-cutting-feature

# Warmup with organic memory before tasks
node bench/realworld/bench-pi-realworld.js --warmup warmup-prompts.json

# Accumulate memory across tasks (simulates real session)
node bench/realworld/bench-pi-realworld.js --accumulate

# Keep worktrees for inspection
node bench/realworld/bench-pi-realworld.js --no-cleanup

# Custom timeout (default 30 min for long-horizon tasks)
node bench/realworld/bench-pi-realworld.js --timeout-ms 600000
```

Results are written under `bench/realworld/results/` with JSONL transcripts and a `report.json` summary.

### Long-horizon tasks (5 tasks)

| Task                                        | Category                 | Description                                                                                  |
| ------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `cross-cutting-add-code-owner`              | cross-cutting-feature    | Add a code_owner concept across schema, data access, domain, and extension layers (8+ files) |
| `debugging-odyssey-compact-crash`           | debugging-odyssey        | Trace a data loss bug spanning compaction, FTS indexing, and search (3+ modules)             |
| `api-migration-hooks-to-events`             | api-migration            | Migrate hook registration from callbacks to event-emitter pattern (10+ files, pure refactor) |
| `architectural-guardian-no-external-search` | architectural-guardian   | Add semantic search enhancement that must respect the no-external-services constraint        |
| `multi-session-continuity-trust-policy`     | multi-session-continuity | Fix trust-sync regression and apply a remembered trust policy from a prior session           |

### Short regression tasks (8 tasks, in `tasks/short/`)

| Task                      | Category         | Description                                      |
| ------------------------- | ---------------- | ------------------------------------------------ |
| `bugfix-createdb-config`  | bugfix           | Fix config isolation in createDb                 |
| `bugfix-search-ranking`   | bugfix           | Fix composite ranking score                      |
| `feature-context-hook`    | feature          | Add contextLimit flag to context-injection       |
| `feature-session-summary` | feature          | Add onCompact hook for session summaries         |
| `refactor-fts5-rank`      | refactor         | Extract scoring weights into configurable object |
| `staleness-code-index`    | staleness        | Detect and fix stale code index references       |
| `review-pr-trust-sync`    | review           | Evaluate trust-sync change correctness           |
| `negative-control-readme` | negative-control | README lookup (no memory needed)                 |

### Task definition format

Each task has:

- `horizon`: `"long"` or absent (short)
- `setup.checkout` — a known-good commit SHA
- `setup.apply_patch` — optional patch to inject a bug
- `setup.seed_memory` — optional memory seed file
- `success.tests` — test commands that must pass
- `success.must_touch` / `success.must_not_touch` — file constraints
- `success.expected_facts` — answer content expectations
- `success.constraints` — semantic diff constraints (e.g., must not contain certain patterns)

### Grading axes

| Axis        | Grader                 | What it measures                                           |
| ----------- | ---------------------- | ---------------------------------------------------------- |
| Tests       | `run-tests.js`         | Do the specified test commands pass?                       |
| Diff        | `check-diff.js`        | Correct files touched, lines changed count                 |
| Answer      | `check-answer.js`      | Response contains expected facts                           |
| Trajectory  | `check-trajectory.js`  | Tool call efficiency, read/edit ratio, error rate          |
| Constraints | `check-constraints.js` | Diff respects semantic constraints (no forbidden patterns) |

### Report

The report shows a comparison table with both basic and trajectory metrics:

```
╔════════════════════════════╤════════════╤════════════╗
║ Metric                     │ Memory Off │ Memory On  ║
╟────────────────────────────┼────────────┼────────────╢
║ Tasks solved               │       1/5  │       4/5  ║
║ Tests passed               │       1/5  │       4/5  ║
║ Median active tokens       │     18,400 │     12,100 ║
║ Median wall time           │    18m 30s │     9m 15s ║
║ Median tool calls          │         42 │         18 ║
║ Wrong-file edits           │          3 │          1 ║
║ Constraint violations      │          2 │          0 ║
║ Median trajectory score    │       0.45 │       0.82 ║
║ Median lines changed       │        340 │        120 ║
║ Median read/edit ratio      │       0.30 │       0.78 ║
╚════════════════════════════╧════════════╧════════════╝
```

This complements the paired benchmark. The paired benchmark tests knowledge retrieval; this benchmark tests code editing, multi-step problem-solving, and architectural awareness over extended tool-use sessions.

## MCP transport benchmarks

Two stdio benchmarks cover the MCP transport's two cost centers. Both spawn the real server (`node memory-store.js mcp`) and speak newline-delimited JSON-RPC, so they measure what an MCP host actually experiences. Numbers are machine-dependent; treat them as local before/after signals, not absolute claims.

### Cold start

`bench/mcp-cold-start.js` spawns fresh servers and measures time-to-initialize-response and time-to-tools-list. Use it when touching module loading, lazy requires, or anything on the startup path.

```bash
npm run bench:mcp-cold -- memory-store.js
```

```bash
node bench/mcp-cold-start.js memory-store.js 9
```

Most of the cold-start floor is outside LaPis' control: node spawn, the MCP SDK + zod module graph, and `ensureDb()`. App-side module deferral has already harvested the large wins (lazy command map, lazy dispatch); see PRs #352/#354 for methodology.

### Warm dispatch

`bench/mcp-warm-dispatch.js` spawns one server, completes the handshake, then times sequential `tools/call` round-trips per tool case (read, code, doc, and write paths) and prints min/p50/p90/mean. Use it when touching dispatch, SQL, ranking, or the handler chain — it catches per-call regressions that cold-start cannot see.

```bash
npm run bench:mcp-warm -- memory-store.js
```

```bash
node bench/mcp-warm-dispatch.js memory-store.js 60
```

`memory-save` cases write rows with unique titles; run against a disposable database (`LAPIS_HOME` pointing at a copy) if you do not want bench rows in your real memory store.

### Hook latency

`bench/hooks-bench.js` spawns `node <entry> claude-code hook <event>` with realistic stdin payloads and measures full process wall time (spawn → exit) — the per-event cost a Claude Code host actually pays. This is the highest-frequency LaPis surface: PreToolUse fires on every tool call, UserPromptSubmit on every prompt (and returns the injected context; its stdout byte size is reported).

```bash
node bench/hooks-bench.js memory-store.js 20
```

Run with `LAPIS_HOME` pointing at a disposable copy — the bench writes session state and UserPromptSubmit performs memory reads.

### CLI one-shots

`bench/cli-one-shot.js` spawns `node <entry> <subcommand>` end-to-end (boot + lazy command map + command + exit) — the cost of every terminal `lapis <cmd>` invocation. Covers the CLI command path; MCP boot is `bench/mcp-cold-start.js`'s job.

```bash
node bench/cli-one-shot.js memory-store.js 15
```

### Memory soak

`bench/memory-soak.js` spawns one MCP server, drives N sequential `memory-search` calls through it, and samples the server process working set (via `tasklist`, Windows) every K calls. Detects leaks in the long-lived server a host keeps alive — the latency benches cannot see this.

```bash
node bench/memory-soak.js memory-store.js 3000 500
```

Run with `LAPIS_HOME` pointing at a disposable copy. A healthy run shows RSS rising then flattening (V8 plateau); unbounded linear growth across the whole run is the leak signal.

### Baselines

Committed machine-readable baselines live in `bench/baselines/` (`baseline-<date>.json`: all measurements + environment metadata + commit hash). `bench/results/` is gitignored by convention — it holds ad-hoc local output (paired/realworld reports). Diff future runs against the newest committed baseline mechanically; treat deltas smaller than the identical-code noise floor recorded inside the artifact as noise.
