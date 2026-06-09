# LaPis Architecture

LaPis is a modular monolith: it ships as one Node.js package and Pi extension, but each feature area has a defined owner, dependency boundary, and test surface.

For the detailed extraction assessment and rationale, see [`ARCHITECTURE_MODULARIZATION.md`](ARCHITECTURE_MODULARIZATION.md). For a directory-by-directory ownership table, see [`MODULE_MAP.md`](MODULE_MAP.md).

## Runtime layers

```text
Pi Agent
  -> extensions/memory-layer/        # Pi hooks, tools, host adapters, formatting adapters
  -> memory-store.js / cli.js        # CLI entry points and command dispatch setup
  -> src/cli/                        # command gateway and feature routers
  -> src/http/                       # optional HTTP server (Aurex domain + code endpoints)
  -> src/{feature}/                  # independently testable feature services
  -> src/platform/ + data-access/    # storage, repositories, protocol formatting
```

![LaPis module boundaries](diagrams/lapis-module-boundaries.png)

This structural view shows the current target shape: extension code adapts Pi events and tools, the CLI gateway maps commands to feature routers, feature services own domain behavior, and platform services own shared storage, config, and protocol formatting.

## Memory lifecycle view

![LaPis memory lifecycle](diagrams/lapis-memory-lifecycle.png)

The lifecycle view complements the module-boundary diagram. Session hooks capture and inject context, feature services handle read/write/index/trust operations, and the local SQLite store persists observations, sessions, code symbols, documentation sections, symbol links, and FTS indexes. Maintenance commands keep the store healthy through compaction and Dream Cycle cleanup without changing the single-database deployment model.

## Layer responsibilities

### Pi extension adapters

`extensions/memory-layer/` registers Pi hooks and tools, performs project detection and native dependency health checks, and adapts backend results for LLM/tool responses. It should degrade gracefully when a feature adapter fails and should not contain raw SQL, parser internals, or feature business logic.

### CLI command gateway

`src/cli/gateway.js` composes feature routers from `src/cli/commands/`. Routers map CLI arguments to feature services and preserve command behavior for `memory-store.js`; they should not become a second implementation of feature logic.

### Feature services

Feature services live under `src/` and own one feature family each:

- `src/memory-domain/` — declarative memory: observations, search, context, sessions, recall, dedupe, compaction, and workspaces.
- `src/code-index/` — repository scanning, parsing, symbol extraction, edge extraction, incremental indexing, and source retrieval.
- `src/code-analysis/` — graph, impact, quality, git-aware, and risk analysis over the code-index read model.
- `src/doc-index/` — Markdown documentation indexing and documentation intelligence.
- `src/trust-sync/` — explicit integration between memory observations and code symbols.
- `src/agent-intel/` — agent-facing coding intelligence orchestration: preflight checks, agent-pack planning, audit-diff, and symbol enrichment.
- `src/token-saver/` — output compression, command classification, token estimation, and savings tracking.

> Note: `src/workflow-memory/` (procedural workflow memory) was removed in commit `a2b151b` (Issue #167). The CLI commands `save-workflow`, `record-step`, `step-outcome`, and `get-workflow` no longer exist; the corresponding module, router, repository, and test files were deleted. Use `memory-save` observations and the trust/session subsystems for the use case this module was originally intended to address.

### HTTP server (Aurex domain)

`src/http/` provides an optional HTTP server for programmatic access. It exposes REST endpoints for the Aurex domain model (missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings, sessions, costs, retry, compression, checkpoints, settings) and code indexing/analysis. The server uses the same repository interfaces as the CLI and is started with `node memory-store.js serve`. It defaults to `127.0.0.1:9100`.

### Platform helpers

`src/platform/` owns shared platform concerns such as storage composition, repository construction, and protocol/output formatting. Feature modules should receive repositories or typed helpers rather than importing unrelated feature internals.

## Dependency rules

1. `extensions/*` may depend on backend clients and formatting adapters, but not raw SQL or parser internals.
2. `memory-domain` may depend on storage, config, and ranking constants, but not code/doc parsers.
3. `code-index` may depend on parser, filesystem, hashing, and storage helpers, but not memory observation ranking.
4. `code-analysis` may depend on code-index read repositories and git metrics, but not Pi extension state.
5. `doc-index` may depend on Markdown/doc storage; documentation coverage may depend only on a narrow code-symbol lookup.
6. `trust-sync` is the only feature module that should coordinate memory observations with code symbol tables.
7. `platform/protocol` owns `_meta`, compact/auto output, and LLM-facing transformations.
8. `src/http/` may depend on platform repositories and feature services, but should not contain business logic or raw SQL.
9. Crosshash remains behind a command/API boundary until it fully replaces the JavaScript code-intelligence path.
10. `agent-intel` may depend on code-index read model, memory-domain search, and doc-index, but must not mutate memory or code indexes.
11. `token-saver` is standalone; it may not depend on feature service internals or Pi extension state.

## Testability expectations

Each feature module should have:

- A public service interface with typed or well-documented inputs and outputs.
- Repository interfaces or fixtures for tests.
- Unit tests that do not start the Pi extension.
- Integration tests against a temporary SQLite database for storage behavior.
- CLI/router tests that verify argument mapping and delegation only.
- Failure-mode tests proving a module failure returns a scoped error and does not break unrelated features.
