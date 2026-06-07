# LaPis

Persistent memory for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). LaPis gives Pi a local memory layer for decisions, bugfixes, patterns, indexed code, indexed docs, and session context.

It runs as one Pi extension plus one local Node.js backend. Storage is SQLite by default at `~/.pi/memory/memory.db`; there are no cloud dependencies and no API keys.

## Architecture

LaPis is a modular monolith: one installable extension with clear internal ownership between Pi adapters, CLI routing, feature services, and shared platform/storage code. The extension calls the backend through in-process `dispatch()` when possible, with child-process fallback for streaming operations such as indexing.

![LaPis Modular Memory Architecture](memory-layer-architecture.png)

### Module boundaries

![LaPis module boundaries](docs/diagrams/lapis-module-boundaries.png)

### Memory lifecycle

![LaPis memory lifecycle](docs/diagrams/lapis-memory-lifecycle.png)

For dependency rules and module ownership details, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md).

## Install

```bash
pi install git:github.com/GeneGulanesJr/LaPis
```

Restart Pi and memory auto-wires on session start. Use `pi update --extensions` to keep it up to date.

LaPis does not install npm dependencies at runtime. If you are running from a local clone or developing the extension, install dependencies explicitly:

```bash
npm install
```

## What It Does

- **Remembers across sessions** - decisions, bugfixes, patterns, discoveries, and constraints persist.
- **Auto-injects context** - new sessions start with relevant memories loaded.
- **Indexes code** - web-tree-sitter parses JS/TS/TSX/Go/Python/Rust/SQL for semantic code lookup and analysis.
- **Indexes docs** - Markdown sections, links, glossary terms, and code examples become searchable.- **Tracks trust** - memories linked to changed code lose confidence; stable linked code recovers trust.
- **Deduplicates memory** - similar saves are merged or flagged before they clutter recall.
- **Manages workspaces** - project isolation is explicit through create/list/archive workflows.
- **Cleans stale memory** - the Dream Cycle removes superseded, never-useful, and replaced memories based on quality signals.
- **Exposes an HTTP API** - optional REST server for programmatic access to missions, milestones, working units, and code analysis.
- **Pre-coding intelligence** - preflight checks combine memory, code, and docs into before-coding context.
- **Compresses CLI output** - token-saving output compression reduces context window usage automatically.
- **Memory dashboard** - observability command for memory health, statistics, and index quality.

## Benchmarks

### Token Efficiency

The wire format (`wire-format.js`) uses compact encoding to reduce the token footprint of analysis responses inside Pi's context window. The benchmark runs real CLI commands against indexed repos, passes output through `compactResponse()`, and compares byte sizes.

Run it with:

```bash
node bench/bench-tokens.js
```

Latest local run: May 24, 2026, with fresh reindexes for both repos. `call-hierarchy` and `blast-radius` were skipped because the benchmark could not select a representative symbol with callers.

#### Percentage Saved per Tool

| Tool         | LaPis / PiMemoryExtension | PCBuilder |
| :----------- | :-----------------------: | :-------: |
| importance   |            21%            |    24%    |
| hotspots     |            0%             |    0%     |
| dead-code    |            44%            |    50%    |
| coupling     |            37%            |    40%    |
| extraction   |            23%            |    22%    |
| import-graph |            18%            |    20%    |
| cycles       |            0%             |    0%     |
| **overall**  |          **40%**          |  **49%**  |

#### Total Savings

|                | LaPis / PiMemoryExtension |          PCBuilder          |
| :------------- | :-----------------------: | :-------------------------: |
| Repo size      | 292 files / 6,913 symbols | 171 files / 207,599 symbols |
| Raw JSON       |         692.6 KB          |           36.7 MB           |
| Compact format |         417.5 KB          |           18.5 MB           |
| Bytes saved    |         275.1 KB          |           18.1 MB           |
| Tokens saved   |      ~80,500 tokens       |      ~5,436,007 tokens      |

See [`bench/README.md`](bench/README.md) for benchmark usage and interpretation notes.

### Paired Memory

The paired benchmark measures whether memory helps by running the same task twice: once with LaPis disabled and once with LaPis active. It is an internal regression and directional benchmark, not a comprehensive external evaluation. It is designed to catch regressions in LaPis behavior; it should not be read as a claim about typical real-world usage, where prompts, repositories, model behavior, provider cache state, and tool choices vary.

Run it with:

```bash
npm run bench:pi-paired
```

Latest run: `bench/results/pi-paired-2026-05-24T14-47-20-651Z/report.json`

| Metric        | Memory On | Without Memory | Savings |
| ------------- | --------- | -------------- | ------- |
| Facts correct | 18/18     | 18/18          | no loss |
| Active tokens | 3,192     | 42,954         | -92.6%  |
| Wall time     | ~86s      | ~233s          | -63.1%  |
| Tool calls    | 6         | 49             | -87.8%  |
| Failed tools  | 0         | 4              | -100%   |

#### Per-category Breakdown

| Category         | Facts (on) | Tokens (on) | Savings |
| ---------------- | ---------- | ----------- | ------- |
| prior-decision   | 3/3        | 128         | 99.0%   |
| bug-history      | 3/3        | 603         | 94.2%   |
| staleness        | 3/3        | 426         | 94.2%   |
| navigation       | 3/3        | 72          | 99.0%   |
| negative-control | 6/6        | 1,963       | 65.7%   |

#### What Each Category Tests

| Category         | What it tests                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| prior-decision   | Recalls an architectural decision and its rationale, then names the current module involved.                                               |
| bug-history      | Recalls why a fix exists, including the historical failure mode that is not obvious from the final code alone.                             |
| staleness        | Checks whether LaPis warns that an indexed code view may be stale and should be verified or reindexed before trust.                        |
| navigation       | Uses memory to jump to the likely hook/module and confirm where extension wiring lives.                                                    |
| negative-control | Asks current-source questions that should not need memory facts; memory-on should route cheaply to code lookup instead of adding overhead. |

Memory-on achieved perfect accuracy with 92.6% fewer active tokens overall. Memory-dependent tasks saved 94.2-99.0% active tokens in this run.

The paired benchmark also reports behavior counters. In the latest run, memory-on used 6 total tools, 4 code-oriented tools, 4 memory tools, 12 assistant turns, and 0 failed tools. These counters help distinguish real memory regressions from normal provider cache and latency variance. The negative-control tasks are current-source questions; they should avoid memory facts and route quickly through `memory-code search` plus targeted reads when code verification is needed.

## Requirements

- Node.js
- `better-sqlite3` for local SQLite access
- No Python dependency
- No API keys or cloud services

## Documentation

- [`CONTRIBUTING.md`](CONTRIBUTING.md) - contributor workflow and checks.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - architecture overview and dependency rules.
- [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md) - module ownership and entry points.
- [`docs/ARCHITECTURE_MODULARIZATION.md`](docs/ARCHITECTURE_MODULARIZATION.md) - detailed modularization assessment.
- [`docs/COMMANDS.md`](docs/COMMANDS.md) - command reference.
- [`docs/API.md`](docs/API.md) - HTTP API and CLI reference.
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) - config file and stored data.
- [`docs/DREAM_CYCLE.md`](docs/DREAM_CYCLE.md) - stale-memory cleanup behavior.
- [`docs/TUTORIAL.md`](docs/TUTORIAL.md) - step-by-step usage guide.

- [`docs/GITHUB_ISSUE_BREAKDOWN.md`](docs/GITHUB_ISSUE_BREAKDOWN.md) - modularization issue breakdown.
- [`docs/code-indexing.md`](docs/code-indexing.md) - async code indexing.
- [`docs/SKILL.md`](docs/SKILL.md) - extension skill overview.

## License

ISC
