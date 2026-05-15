# LaPis Architecture

LaPis is a modular monolith for persistent Pi agent memory. It ships as one package with one local SQLite database and one Pi extension, while keeping feature areas independently understandable, testable, and replaceable.

For the historical modularization rationale and detailed extraction sequence, see `docs/ARCHITECTURE_MODULARIZATION.md`. For a quick directory-by-directory ownership reference, see `docs/MODULE_MAP.md`.

## System shape

LaPis currently has two major implementation areas:

1. **Node/Pi runtime** — the Pi extension, command handlers, service modules, data-access helpers, SQLite storage, documentation indexing, code indexing, memory ranking, and trust maintenance.
2. **Crosshash Rust workspace** — a typed code-intelligence engine for parsing, hashing, graph storage, traversal, impact analysis, AI-assisted edge inference, APIs, and CLI surfaces.

The target backend shape is layered:

```text
Pi Agent
  │
  ▼
extensions/memory-layer/
  ├─ hook adapters
  ├─ tool adapters
  └─ backend client
       │
       ▼
src/cli or src/api command gateway
  ├─ memory router
  ├─ workflow router
  ├─ code-index router
  ├─ code-analysis router
  ├─ doc-index router
  ├─ trust-sync router
  └─ maintenance router
       │
       ▼
Feature services
  ├─ memory-domain
  ├─ workflow-memory
  ├─ code-index
  ├─ code-analysis
  ├─ doc-index
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

This structure allows LaPis to keep deployment simple while reducing blast radius. A documentation-indexing failure should not disable memory search, a formatting bug should not corrupt storage, and trust syncing should be the only intentional bridge between memory observations and code-symbol tables.

## Feature boundaries

### Pi extension integration

The extension owns Pi lifecycle integration: hooks, tool registration, command registration, passive memory capture, context injection, guardrails, trust-sync triggers, and user-facing formatting. It should talk to the backend through a client or command boundary rather than importing storage or parser internals.

### Memory domain

The memory domain owns declarative observations, search/context ranking, sessions, prompts, dedupe, recall feedback, compaction, dream cleanup, and workspace isolation. It should not depend on code or documentation parser internals.

### Workflow memory

Workflow memory owns named procedures, ordered steps, outcomes, attempts, and recovery of known-good workflows. It shares storage and workspace identity but should not depend on observation ranking.

### Code index

The code index owns repository registration, file discovery, ignore handling, language detection, parser selection, symbol extraction, import/call edge extraction, incremental indexing, and byte-accurate source retrieval.

### Code analysis

Code analysis owns graph, impact, quality, git-aware, AST-pattern, and risk queries over the code-index read model. It should consume typed code-index data rather than parser implementation details.

### Documentation index

Documentation indexing owns markdown sections, doc search, outlines, backlinks, broken-link detection, glossary terms, tutorial paths, code examples, doc orphans, duplicates, coverage, and stale-page checks. Coverage may call a narrow code-symbol lookup interface.

### Trust sync

Trust sync owns the intentional cross-feature relationship between memories and code symbols: symbol links, trust policy, change detection, recall feedback, related-memory lookup, and stale-link repair. It should be the only module that mutates both memory and code-link/trust tables.

### Platform

Platform owns SQLite lifecycle, migrations, repository interfaces, configuration loading, command argument parsing, JSON output, response envelopes, compact wire format, process execution, and shared infrastructure.

### Crosshash

Crosshash is the Rust code-intelligence workspace. Keep it behind a process/API boundary from the Node/Pi extension until it becomes the canonical code-intelligence backend.

## Dependency rules

1. `extensions/*` may depend on backend clients and formatting adapters, but not raw SQL or parser internals.
2. `memory-domain` may depend on storage, config, and ranking constants, but not code/doc parsers.
3. `workflow-memory` may depend on storage and project identity only.
4. `code-index` may depend on parser, filesystem, hashing, and storage, but not memory observation ranking.
5. `code-analysis` may depend on code-index read repositories and git metrics, but not Pi extension state.
6. `doc-index` may depend on Markdown/doc storage; doc coverage may depend only on a `CodeSymbolLookup` interface.
7. `trust-sync` is the only feature module allowed to coordinate memory and code symbol tables.
8. `platform/protocol` owns `_meta`, compact/auto output, and LLM-facing transformations.
9. Crosshash stays behind a command/API boundary unless the architecture is explicitly changed.

## Testing strategy

Each feature module should have:

- A public service interface with typed inputs and outputs.
- Repository interfaces or fixtures for tests.
- Unit tests that do not start the Pi extension.
- Integration tests against a temporary SQLite database.
- CLI/router tests that verify argument mapping only.
- Failure-mode tests proving a module failure returns a scoped error and does not break unrelated features.

## Maintenance

When adding or moving a module:

1. Add or update the module entry-point boundary comment.
2. Update `docs/MODULE_MAP.md` with purpose, entry point, dependencies, and forbidden dependencies.
3. Update `CONTRIBUTING.md` if the change affects where contributors should add new behavior.
4. Update `README.md` if user-facing setup, commands, or high-level paths changed.
