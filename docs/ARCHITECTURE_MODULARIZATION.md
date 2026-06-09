# Architecture modularization assessment

This document identifies the feature areas in LaPis as a Pi Agent extension and proposes module boundaries that would let one feature fail without taking down the rest of the system.

## Current shape

LaPis currently has two implementations moving in parallel:

1. **Primary Pi extension + Node CLI/runtime** — `extensions/memory-layer/index.ts` registers Pi hooks, LLM tools, and commands, then shells into `memory-store.js`. `memory-store.js` owns command dispatch and coordinates SQLite, memory, code indexing, code analysis, git analysis, doc indexing, response envelopes, and AST pattern scans.
2. **Crosshash Rust workspace** — `crosshash/` is already closer to the desired modular shape, with crates for core types, parsing, hashing, graph storage/traversal, git integration, AI inference, impact analysis, API, MCP, and CLI.

The main modularization opportunity is the Node/Pi extension runtime: it exposes clear feature families, but several families are still coupled through a large extension file, a large CLI dispatcher, shared schema, shared process boundary, and shared module-level state.

## Main feature groups and sub-features

### 1. Pi extension integration layer

**Current entry points**

- Pi lifecycle hooks in `extensions/memory-layer/index.ts`.
- LLM tools registered from the same file.
- User-facing Pi commands for memory statistics, dream cleanup, and context display.

**Sub-features**

- Native dependency health check and rebuild for `better-sqlite3`.
- Project detection and known indexed repo discovery.
- Session lifecycle handling:
  - session start and orphan recovery notification,
  - re-injection after compaction,
  - context injection before agent start,
  - session shutdown summaries.
- Tool-call guardrails:
  - memory-code/read enforcement state,
  - automatic trust sync after git operations,
  - automatic memory reminders and nudges.
- Passive memory capture:
  - user prompt capture,
  - auto-detected decisions/bugfixes/discoveries,
  - periodic progress checkpoints.
- Tool presentation and formatting:
  - `memory-save`, `memory-search`, `memory-get`, `memory-update`, `memory-delete`, `memory-related`, `memory-load-context`, `memory-sync-code-trust`, `memory-code`, and `memory-doc`.

**Boundary to establish**

Split this into a thin extension host plus independently testable adapters:

```text
extensions/memory-layer/
  index.ts                       # registers hooks/tools only
  host/
    memory-client.ts             # process/API client for backend commands
    project-detector.ts
    repo-cache.ts
    native-health.ts
  hooks/
    session-lifecycle.ts
    context-injection.ts
    passive-capture.ts
    tool-guardrails.ts
    trust-sync.ts
  tools/
    memory-tools.ts
    code-tools.ts
    doc-tools.ts
    format-code-result.ts
    format-doc-result.ts
```

The extension host should degrade gracefully when a feature adapter fails. For example, doc indexing failure should not disable memory search, and passive capture failure should not block session startup.

### 2. Declarative memory and session memory

**Current entry points**

- `memory-store.js` commands: `save`, `search`, `context`, `get`, `update`, `delete`, `timeline`, `suggest-topic-key`, `stats`, `session-summary`, `compact`, and `dream`.
- SQLite tables for observations, observation FTS, prompts, sessions, recalls, duplicates, and workspaces.

**Sub-features**

- Observation CRUD.
- Hybrid ranking for search/context.
- Session start/end tracking.
- Prompt capture.
- Duplicate detection and merge tracking.
- Compaction and dream cleanup.
- Recall logging and ranking feedback.
- Workspace/project isolation.

**Boundary to establish**

Move these concerns behind a `memory-domain` module that has no dependency on code indexing or docs:

```text
src/memory-domain/
  observations.ts
  search.ts
  context.ts
  sessions.ts
  recall.ts
  dedupe.ts
  compaction.ts
  workspaces.ts
```

This domain should expose typed functions and return domain results, not CLI envelopes. CLI/extension formatting should live outside it.

### 3. Procedural workflow memory — REMOVED (Issue #167)

The `workflow-memory` module and its commands (`save-workflow`, `record-step`, `step-outcome`, `get-workflow`) were removed in commit `a2b151b` because the underlying `procedural_memory` and `procedural_steps` tables had zero rows in production and were not in use. The decisions/trust/auto-capture/preflight subsystems already cover the use case this module was originally intended to address. Any smoke test or doc referencing these commands (e.g. `--help lists save-workflow`) is stale and should be removed; the rest of this subsection is kept for historical context only.

**Original entry points (no longer applicable)**

- `memory-store.js` commands: `save-workflow`, `record-step`, `step-outcome`, and `get-workflow`.
- SQLite tables: `procedural_memory` and `procedural_steps`.

**Original sub-features (no longer applicable)**

- Persist named workflows.
- Persist ordered commands/steps.
- Track step success, attempts, and workarounds.
- Recover successful procedures across sessions.

**Original boundary (no longer applicable)**

Extract as `workflow-memory` because it has a distinct model and should not be coupled to observation ranking:

```text
src/workflow-memory/
  workflows.ts
  steps.ts
  scoring.ts
```

It should only share the storage adapter and project/workspace identity with declarative memory.

### 4. Code indexing and retrieval

**Current entry points**

- `memory-store.js` commands: `index-repo`, `reindex-repo`, `search-code`, `get-code-source`, `list-code-repos`, and `remove-code-repo`.
- `parse-code.js` for WASM tree-sitter parsing and symbol extraction.
- `utils.js` for code walking, ignores, and hashing.
- SQLite tables for code repos, files, symbols, FTS, imports, calls, and complexity.

**Sub-features**

- Repository registration and removal.
- File discovery and ignore filtering.
- Language detection and parser selection.
- Symbol extraction for JS/TS, Python, Rust, SQL, and related supported files.
- Import and call edge extraction.
- Incremental reindexing through mtime/content tracking.
- Byte-accurate source retrieval.

**Boundary to establish**

Separate indexing from analysis and memory:

```text
src/code-index/
  repos.ts
  scanner.ts
  parser-registry.ts
  symbol-extractor.ts
  edge-extractor.ts
  incremental-indexer.ts
  source-retrieval.ts
```

The indexer should emit a well-defined `CodeIndexSnapshot` or write through a `CodeIndexRepository` interface. It should not call memory trust logic or format LLM responses directly.

### 5. Code analysis and code intelligence

**Current entry points**

- `code-analysis.js` for import graph, call hierarchy, blast radius, dead code, complexity, hotspots, cycles, importance, coupling, extraction candidates, class hierarchy, signal chains, layer violations, winnow, untested symbols, and PR risk.
- `git-analysis.js` for churn and provenance.
- `ast-patterns.js` for AST pattern scans.
- `response-meta.js` and `wire-format.js` for result envelopes and compact output.

**Sub-features**

- Dependency graph and call graph queries.
- Risk and impact queries.
- Structural quality queries.
- Git-aware queries.
- AST smell/pattern queries.
- Result confidence/freshness metadata.
- Compact/auto formatting.

**Boundary to establish**

Create independently executable analyzers that consume code-index data and return typed analysis DTOs:

```text
src/code-analysis/
  graph.ts
  impact.ts
  quality.ts
  git-metrics.ts
  ast-patterns.ts
  risk.ts
  query-winnow.ts
  metadata.ts
  formatters/
    compact.ts
    llm.ts
```

The analysis layer should depend on the code index read model and git provider, but not on memory observations or Pi extension state.

### 6. Documentation indexing and documentation intelligence

**Current entry points**

- `doc-indexer.js` for indexing and querying Markdown documentation.
- `memory-store.js` commands: `index-docs`, `reindex-docs`, `doc-search`, `doc-outline`, `backlinks`, `broken-links`, `glossary`, `tutorial-path`, `code-examples`, `doc-orphans`, `doc-coverage`, `stale-pages`, and `doc-duplicates`.
- SQLite tables for doc repos, files, sections, FTS, links, terms, and code blocks.

**Sub-features**

- Markdown section indexing.
- Section search, outline, and role classification.
- Link graph and broken link analysis.
- Glossary extraction and lookup.
- Tutorial path traversal.
- Code example extraction.
- Doc/code coverage and staleness checks.

**Boundary to establish**

Make documentation a peer to code indexing rather than a branch of memory-store dispatch:

```text
src/doc-index/
  repos.ts
  markdown-parser.ts
  sections.ts
  links.ts
  glossary.ts
  examples.ts
  analytics.ts
```

Doc features should use their own repository interface and should not depend on code-index internals except through a narrow `CodeSymbolLookup` interface for coverage checks.

### 7. Agent intelligence and preflight orchestration

**Current entry points**

- `src/agent-intel/preflight.js` for pre-coding intelligence combining memory, code, and docs.
- `memory-store.js` commands: `preflight`, `agent-pack`.
- `src/agent-intel/` modules: `audit-diff.js`, `blast.js`, `dupes.js`, `runtime-ingest.js`, `stale-flags.js`, `symbol-enrichment.js`.

**Sub-features**

- Preflight checks: combines code search, memory recall, related files/tests, docs, duplicate warnings, and recommended action.
- Agent-pack planning: compact Pi planning packet with must-read files, relevant symbols, past decisions, and risk.
- Audit-diff: compares code changes against memory expectations.
- Symbol enrichment: enriches code symbols with cross-references from memory and docs.
- Runtime ingest: ingests runtime signals into the code index read model.
- Stale-flags: detects and flags stale index entries.

**Boundary to establish**

Agent-intel is a read-only orchestration layer. It composes results from other feature modules but must never mutate state:

```text
src/agent-intel/
  preflight.js
  agent-pack.js
  audit-diff.js
  blast.js
  dupes.js
  runtime-ingest.js
  stale-flags.js
  symbol-enrichment.js
```

It should depend on code-index, memory-domain, and doc-index through read-only interfaces only.

### 8. Token saver and output compression

**Current entry points**

- `src/token-saver/index.js` for command output compression and token savings tracking.
- `src/token-saver/` modules: `classify-command.js`, `compress-output.js`, `estimate-tokens.js`, `savings-store.js`.

**Sub-features**

- Command classification (build, test, lint, etc.).
- Output compression and summarization.
- Token count estimation.
- Savings statistics tracking and reporting.

**Boundary to establish**

Token-saver is fully standalone. It has no dependency on feature service internals:

```text
src/token-saver/
  index.js
  classify-command.js
  compress-output.js
  estimate-tokens.js
  savings-store.js
  rules/
```

It should remain independent of all feature modules and can be used as a general-purpose output compression utility.

### 9. Trust, symbol linking, and cross-feature maintenance

**Current entry points**

- `memory-store.js` commands: `link-symbol`, `auto-link`, `adjust-trust`, `record-recall`, `stale-links`, `sync-code-trust`, `trust-recovery`, `related`, and `symbol-cluster`.
- Extension hook that launches `sync-code-trust` after git operations.
- Shared `symbol_links` table connects observations to indexed code symbols.

**Sub-features**

- Link memories to code symbols.
- Trust score adjustment based on changed symbols.
- Recall feedback and trust recovery.
- Symbol clusters and related memory lookup.
- Stale link detection.

**Boundary to establish**

This is a cross-cutting integration module. Keep it small and explicit:

```text
src/trust-sync/
  symbol-links.ts
  trust-policy.ts
  change-detector.ts
  related-memory.ts
```

It should depend on `memory-domain` and `code-index` through interfaces only. It should be the only module that mutates both memory tables and code-link/trust tables.

### 10. Storage, configuration, and wire protocol

**Current entry points**

- `db.js` provides DB initialization, SQL helpers, engine selection, argument parsing, JSON output helpers, and error types.
- `schema.sql` defines all feature tables in one database.
- `config.js` and `constants.js` provide shared configuration and ranking/limit constants.
- `wire-format.js` and `response-meta.js` shape responses for agents.

**Sub-features**

- SQLite engine selection and lifecycle.
- Schema migration/initialization.
- CLI parsing and JSON output.
- Shared ranking constants and time windows.
- Response metadata and compact formatting.

**Boundary to establish**

Split foundational infrastructure from presentation:

```text
src/platform/
  storage/
    db.ts
    migrations.ts
    repositories/
  config/
    load-config.ts
    defaults.ts
  cli/
    args.ts
    json-output.ts
  protocol/
    envelope.ts
    compact-format.ts
```

A feature module should receive a storage/repository dependency instead of importing raw SQL helpers globally.

### 11. HTTP server (Aurex domain)

**Current entry points**

- `src/http/server.js` for HTTP server creation, route registration, and startup.
- `src/http/routes.js` for route pattern matching with path parameters.
- `src/http/errors.js` for JSON error response helpers.
- `src/http/handlers/` with 18 handler modules covering the Aurex domain and code endpoints.

**Sub-features**

- Aurex domain CRUD: missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings.
- Session registration and per-milestone session listing.
- Memory search over HTTP.
- Cost tracking per mission.
- Retry and rescope logging per milestone.
- Context compression (stub).
- Checkpoint create/resolve/query.
- Key-value settings store.
- Code indexing, reindexing, health, summary, dependency graph, and hotspots via GET endpoints.

**Boundary to establish**

Keep handlers thin — they parse parameters, call repository methods, and format JSON responses:

```text
src/http/
  server.js          # createHttpServer, startHttpServer, buildRoutes
  routes.js           # matchRoute, matchPath
  errors.js           # jsonError, jsonOk helpers
  handlers/
    health.js         # /health
    missions.js       # /missions
    milestones.js     # /milestones
    units.js          # /units
    handoffs.js       # handoff writes
    contracts.js      # contract create/supersede/history
    verdicts.js       # verdict write/classify/query
    broadcasts.js     # broadcast write/transition/query
    findings.js       # finding write/transition/query
    sessions.js       # session register/query
    memory.js         # /memory/search
    costs.js          # cost log/query
    compression.js    # compression stub
    retry.js          # retry/rescope
    checkpoints.js    # checkpoint CRUD
    settings.js       # KV settings CRUD
    code-index.js     # code index/reindex/health/summary/graph/hotspots
```

Handlers should not contain business logic. They should receive a repository dependency at construction time and delegate all domain work to the repository or feature service.

### 12. Crosshash Rust engine

**Current entry points**

- Rust workspace under `crosshash/` with crates for core, parser, hash, graph, git, impact, AI, API, MCP, and CLI.

**Sub-features**

- Typed core models and errors.
- Multi-language parser and entity extraction.
- Content hashing and incremental hashing.
- Graph storage/traversal and staleness/concurrency support.
- Git operations/history.
- AI-assisted edge inference and API surface discovery.
- Impact analysis and reports.
- API, MCP, and CLI surfaces.

**Boundary to establish**

Treat Crosshash as the future code-intelligence backend. The Node feature modules should eventually call it through a stable process/API boundary rather than duplicating graph/indexing concepts in JavaScript. Until then, keep Crosshash isolated and avoid adding Pi extension concerns inside Rust crates.

## Tight coupling to separate

### A. Extension host is coupled to all tool behavior and formatting

`extensions/memory-layer/index.ts` currently contains lifecycle logic, stateful guardrails, command client code, result formatting, tool schemas, and command registration. A bug in formatting or repo-cache logic can affect unrelated hooks/tools because they share file-level state and helper functions.

**Separate by**: moving hooks, tools, formatters, and backend client code into separate modules with local state and defensive error boundaries.

### B. `memory-store.js` is a monolithic backend and CLI dispatcher

`memory-store.js` handles memory CRUD, session lifecycle, procedural memory, indexing, reindexing, code analysis dispatch, doc analysis dispatch, git analysis, trust syncing, response metadata, wire formatting, and JSON CLI output. It imports all backend modules in one process, and many commands share global `db` and helper functions.

**Separate by**: replacing the single command map with feature routers, for example:

```text
src/cli/commands/
  memory.js
  workflow.js
  code-index.js
  code-analysis.js
  docs.js
  trust.js
  agent-intel.js
  token-saver.js
  dashboard.js
  maintenance.js
```

Each router should depend on a feature service, not on raw SQL helpers.

### C. Storage schema is shared without module ownership

All features share one SQLite database and one schema file. That is acceptable for deployment simplicity, but ownership boundaries are unclear: memory tables, code graph tables, doc graph tables, trust tables, and analytics tables are interleaved.

**Separate by**: keeping a single DB file but organizing migrations by feature area and using repository interfaces so modules cannot casually mutate unrelated tables.

### D. Code indexing and code analysis are coupled through implementation details

Indexing writes symbols, imports, calls, and complexity metrics; analysis reads those tables directly. This is efficient, but analysis behavior can become coupled to the parser's incidental schema choices.

**Separate by**: defining a code-index read model (`CodeRepository`, `CodeFile`, `CodeSymbol`, `ImportEdge`, `CallEdge`, `ComplexityMetric`) and requiring analysis to consume that model through repository methods.

### E. Trust sync bridges memory and code too broadly

`sync-code-trust` and related commands necessarily bridge memories and code symbols, but they currently live in the same monolithic command file as both memory and code indexing.

**Separate by**: isolating trust sync as an integration feature with explicit interfaces to memory and code-index modules.

### F. Docs and code are coupled by dispatch and coverage queries

Documentation indexing has its own model, but it is dispatched through `memory-store.js` alongside code commands. `doc-coverage` crosses docs and code directly.

**Separate by**: keeping docs independent, then exposing a small `CodeSymbolLookup` dependency for coverage only.

### G. Presentation concerns are mixed into backend commands

Result envelopes, compact response stripping, and LLM-facing formatting are close to data retrieval and command dispatch.

**Separate by**: returning typed domain results from services, wrapping them at CLI/API/extension boundaries only.

## Proposed architecture boundaries

The clean target architecture is a layered modular monolith with a single deployable package at first, but independently testable feature modules:

```text
Pi Agent
  │
  ▼
extensions/memory-layer/index.ts
  ├─ hook adapters
  ├─ tool adapters
  └─ backend client
       │
       ▼
src/cli command gateway  or  src/http HTTP server
  ├─ memory router             ├─ Aurex domain handlers
  ├─ workflow router           ├─ memory search handler
  ├─ code-index router         ├─ code index/analysis handlers
  ├─ code-analysis router      └─ settings/checkpoint handlers
  ├─ doc-index router
  ├─ agent-intel router
  ├─ token-saver router
  ├─ dashboard router
  ├─ trust-sync router
  └─ maintenance router
       │
       ▼
Feature services
  ├─ memory-domain
  ├─ code-index
  ├─ code-analysis
  ├─ doc-index
  ├─ agent-intel
  ├─ token-saver
  ├─ trust-sync
  └─ maintenance
       │
       ▼
Platform
  ├─ storage repositories + migrations
  ├─ config
  ├─ git provider
  ├─ process runner
  └─ protocol/formatting
```

### Dependency rules

1. `extensions/*` may depend on the backend client and formatting adapters, but not raw SQL or parser internals.
2. `memory-domain` may depend on storage, config, and ranking constants, but not code/doc parsers.
3. `code-index` may depend on parser, filesystem, hashing, and storage, but not memory observation ranking.
4. `code-analysis` may depend on code-index read repositories and git metrics, but not Pi extension state.
5. `doc-index` may depend on Markdown/doc storage; doc coverage may depend only on `CodeSymbolLookup`.
6. `trust-sync` is the only module allowed to coordinate memory and code symbol tables.
7. `platform/protocol` owns `_meta`, compact/auto output, and LLM-facing transformations.
8. `src/http/` may depend on platform repositories and feature services, but should not contain business logic or raw SQL.
9. Crosshash should remain behind a command/API boundary until it fully replaces the JS code-intelligence path.
10. `agent-intel` may depend on code-index read model, memory-domain search, and doc-index, but must not mutate memory or code indexes.
11. `token-saver` is standalone; it may not depend on feature service internals or Pi extension state.

## Suggested extraction order

1. **Extract backend client and formatters from the extension.** This is low risk and immediately makes Pi tool behavior easier to test.
2. **Split `memory-store.js` command dispatch into feature routers.** Keep behavior unchanged while reducing blast radius.
3. **Extract storage repositories.** Wrap SQL access by feature area before changing schemas.
4. **Extract memory-domain.** Move observation/session/search/dedupe/dream logic behind typed functions.
5. **Extract code-index from code-analysis.** Make indexing produce a stable read model consumed by analysis.
6. **Extract docs into a standalone doc-index feature.** Keep doc coverage behind an explicit code lookup interface.
7. **Extract trust-sync integration.** Make memory/code coupling explicit and easy to test in isolation.
8. **Decide Crosshash migration direction.** Either promote Rust as the canonical code intelligence backend or keep it as a separate experimental engine; avoid maintaining two implicit architectures indefinitely.
9. **Remove dead features.** `workflow-memory` was retired in Issue #167 because the underlying tables were empty; future candidates (e.g. unused exports, dead package entries) should be deleted rather than kept around as stubs.

## Independently testable module checklist

Each feature module should have:

- A public service interface with typed inputs/outputs.
- Repository interfaces or fixtures for tests.
- Unit tests that do not start the Pi extension.
- Integration tests against a temporary SQLite database.
- A CLI/router test that verifies argument mapping only.
- Failure-mode tests proving that a module failure returns a scoped error and does not break unrelated features.

## Deployment strategy

Start as a **modular monolith**: one package, one SQLite DB, one Pi extension, but multiple internal modules with strict dependency rules. Once boundaries are stable, only then consider separate deployables:

- Pi extension package.
- Memory backend CLI/API.
- Crosshash code-intelligence engine.
- Optional docs indexer worker.

This avoids premature distribution complexity while still making features independently testable and resilient.
