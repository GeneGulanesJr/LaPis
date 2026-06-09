# LaPis Documentation Index

This page is the entry point to the LaPis documentation. Use it to find the right doc for a topic, and to confirm the verified test/file counts that back the project.

## Verified counts (from `npm test`)

- Test files: **89**
- Tests passing: **1454**
- Tests skipped: **1**
- Tests total: **1455**

Run `npm test` to regenerate.

## Documentation map

| Topic                                | Doc                                              |
| ------------------------------------ | ------------------------------------------------ |
| Top-level project overview           | [`README.md`](../README.md)                      |
| Contributor workflow and checks      | [`CONTRIBUTING.md`](../CONTRIBUTING.md)          |
| Architecture overview                | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)        |
| Module ownership and boundaries      | [`docs/MODULE_MAP.md`](MODULE_MAP.md)            |
| Modularization rationale             | [`docs/ARCHITECTURE_MODULARIZATION.md`](ARCHITECTURE_MODULARIZATION.md) |
| GitHub issue breakdown (drafts)      | [`docs/GITHUB_ISSUE_BREAKDOWN.md`](GITHUB_ISSUE_BREAKDOWN.md) |
| Full CLI command reference           | [`docs/COMMANDS.md`](COMMANDS.md)                |
| HTTP API and CLI usage               | [`docs/API.md`](API.md)                          |
| Configuration file and stored data   | [`docs/CONFIGURATION.md`](CONFIGURATION.md)      |
| Dream Cycle (stale-memory cleanup)   | [`docs/DREAM_CYCLE.md`](DREAM_CYCLE.md)          |
| Step-by-step usage tutorial          | [`docs/TUTORIAL.md`](TUTORIAL.md)                |
| Async code indexing                  | [`docs/code-indexing.md`](code-indexing.md)      |
| Extension skill overview             | [`docs/SKILL.md`](SKILL.md)                      |
| Memory layer skill (authoritative)   | [`../skills/memory-layer/SKILL.md`](../skills/memory-layer/SKILL.md) |
| Token efficiency benchmark           | [`../bench/README.md`](../bench/README.md)       |
| Module boundaries diagram            | [`docs/diagrams/lapis-module-boundaries.png`](diagrams/lapis-module-boundaries.png) |
| Memory lifecycle diagram             | [`docs/diagrams/lapis-memory-lifecycle.png`](diagrams/lapis-memory-lifecycle.png) |
| Top-level architecture diagram       | [`../memory-layer-architecture.png`](../memory-layer-architecture.png) |

## API surface summary

### CLI subcommands

Grouped by router under `src/cli/commands/`. Full syntax in [`docs/COMMANDS.md`](COMMANDS.md).

- **Memory**: `save`, `update`, `delete`, `get`, `search`, `context`, `timeline`, `check-dup`, `mark-dup`, `suggest-topic-key`, `stats`, `log-negative-recall`
- **Passive capture**: `save-prompt`, `capture-passive`
- **Code index**: `index-repo`, `index-repo-async`, `index-status`, `list-index-jobs`, `reindex-repo`, `health-code-repo`, `search-code`, `ranked-code-context`, `get-code-source`, `list-code-repos`, `remove-code-repo`
- **Code analysis**: `import-graph`, `call-hierarchy`, `blast-radius`, `dead-code`, `complexity`, `outline`, `churn`, `hotspots`, `cycles`, `importance`, `coupling`, `extractable`, `hierarchy`, `signal-chains`, `layer-violations`, `winnow`, `ast-patterns`, `provenance`, `untested`, `pr-risk`, `coding-context`
- **Docs**: `index-docs`, `reindex-docs`, `list-doc-repos`, `doc-search`, `doc-outline`, `backlinks`, `broken-links`, `glossary`, `tutorial-path`, `code-examples`, `doc-orphans`, `doc-coverage`, `stale-pages`, `doc-duplicates`
- **Trust**: `link-symbol`, `auto-link`, `adjust-trust`, `record-recall`, `stale-links`, `sync-code-trust`, `symbol-cluster`, `related`
- **Sessions/workspaces**: `session-start`, `session-end`, `session-summary`, `auto-recover`, `recover-orphans`, `trust-recovery`, `list-projects`, `list-workspaces`, `create-workspace`, `archive-workspace`
- **Maintenance**: `init`, `compact`, `dream`, `dashboard`
- **Agent intel**: `preflight`, `agent-pack`, `dupes`, `enrich-symbols`, `symbol-meta`, `audit-diff`, `runtime-ingest`, `hot-symbols`, `cold-symbols`, `blast`, `stale-flags`
- **Top-level**: `serve` (HTTP), `run` (token saver)

### HTTP endpoints

Started via `node memory-store.js serve`. Defaults to `127.0.0.1:9100`. Full endpoint list in [`docs/API.md`](API.md).

## Environment and configuration

LaPis does not use any user-facing environment variables for general operation. The only knob that can be tuned via environment is the home directory (`HOME` / `USERPROFILE`), which is standard OS behavior. All other tuning lives in `~/.pi/memory/config.jsonc` — see [`docs/CONFIGURATION.md`](CONFIGURATION.md) for the full key list and defaults.

Benchmark harnesses under `bench/` read a few additional environment variables (`LAPIS_PATH`, `BENCH_PI_MEMORY_OFF_CMD`, `BENCH_PI_MEMORY_ON_CMD`); these are documented in [`bench/README.md`](../bench/README.md).
