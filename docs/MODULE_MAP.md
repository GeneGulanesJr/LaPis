# Module Map

This file is the quick reference for LaPis module ownership. Update it whenever a module is added, removed, renamed, or receives a new public entry point.

## Current compatibility layout

The current branch still contains legacy-compatible root modules while the backend is being modularized. These directories remain active and should map cleanly to the target modules below.

| Area | Current directory/file | Owns | Target module |
| --- | --- | --- | --- |
| Pi extension integration | `extensions/memory-layer/` | Pi hooks, tool registration, command registration, passive capture, guardrails, user-facing formatting | `extensions/memory-layer/host/`, `hooks/`, `tools/` |
| CLI command handlers | `commands/` and `memory-store.js` | CLI command dispatch and command-specific adapters | `src/cli/commands/` |
| Feature services | `services/` | Current memory, code, docs, trust, session, recovery, dedupe, search, and dream services | `src/*` feature services |
| Storage helpers | `data-access/` and `db.js` | SQLite helpers, repositories, workspace/observation/symbol/workflow access | `src/platform/storage/` |
| Code parsing and analysis | `parse-code.js`, `code-analysis.js`, `ast-patterns.js`, `git-analysis.js` | Parser orchestration, analysis queries, AST scans, git metrics | `src/code-index/`, `src/code-analysis/` |
| Documentation indexing | `doc-indexer.js` | Markdown section indexing, links, glossary, examples, doc analytics | `src/doc-index/` |
| Protocol and metadata | `wire-format.js`, `response-meta.js` | Compact responses, metadata, LLM-facing result envelopes | `src/platform/protocol/` |
| Configuration/constants | `config.js`, `constants.js` | Config loading, defaults, shared constants | `src/platform/config/` |
| Rust engine | `crosshash/` | Parser/hash/graph/API/CLI crates for code intelligence | `crosshash/` |

## Target feature modules

| Module | Entry point | Purpose | Allowed dependencies | Must not depend on |
| --- | --- | --- | --- | --- |
| `extensions/memory-layer/` | `extensions/memory-layer/index.ts` | Register Pi hooks, tools, commands, context injection, passive capture, guardrails, and user-facing formatting | Backend client, extension-local formatters, project detection helpers | Raw SQL helpers, parser internals, feature-service implementation details |
| `src/memory-domain/` | `src/memory-domain/index.ts` | Declarative observations, memory search/context, sessions, prompt capture, dedupe, recall, compaction, dream cleanup, workspace isolation | `src/platform/storage/`, `src/platform/config/`, ranking constants | `src/code-index/`, `src/doc-index/`, `extensions/`, parser internals |
| `src/workflow-memory/` | `src/workflow-memory/index.ts` | Procedural workflows, ordered steps, step outcomes, attempts, and recovered procedures | `src/platform/storage/`, workspace/project identity | Observation ranking, code analysis, docs, Pi extension state |
| `src/code-index/` | `src/code-index/index.ts` | Repo registration, scanning, ignore filtering, language detection, parser selection, symbol extraction, import/call edges, incremental indexing, source retrieval | Filesystem, parser registry, hashing, `src/platform/storage/` | Memory observation ranking, doc analytics, Pi extension state |
| `src/code-analysis/` | `src/code-analysis/index.ts` | Import/call graph queries, blast radius, dead-code detection, complexity, hotspots, cycles, importance, coupling, refactoring candidates, hierarchy, signal chains, layer violations, risk | Code-index read repositories, git provider, `src/platform/protocol/` formatters at boundaries | Raw parser implementation details, memory-domain internals, Pi extension state |
| `src/doc-index/` | `src/doc-index/index.ts` | Markdown section indexing, doc search, outlines, backlinks, broken links, glossary, tutorial paths, code examples, orphans, coverage, stale pages, duplicates | Markdown parser/storage, `src/platform/storage/`, optional `CodeSymbolLookup` for coverage only | Code-index internals beyond lookup interface, memory ranking, Pi extension state |
| `src/trust-sync/` | `src/trust-sync/index.ts` | Symbol links, trust policy, change detection, recall feedback, stale-link repair, related-memory lookup | Memory-domain interfaces, code-index interfaces, git/change detector, `src/platform/storage/` | Parser internals, doc-index internals, Pi extension state |
| `src/platform/` | `src/platform/index.ts` | SQLite lifecycle, migrations, repositories, config, CLI parsing, JSON output, response envelopes, compact format, process execution | Standard library/runtime dependencies and low-level package dependencies | Feature-domain business rules |
| `crosshash/` | `crosshash/crates/*` | Rust code-intelligence engine for parsing, hashing, graph storage/traversal, impact analysis, AI edge inference, API, and CLI | Rust workspace crates and explicit process/API contracts | Pi extension concerns, Node runtime globals |

## Required entries for `src/*-domain/` and `src/platform/`

When the `src/` modular backend is present, every `src/*-domain/` directory and `src/platform/` sub-area must have a row in this file. At minimum, verify these paths when reviewing architecture changes:

- `src/memory-domain/`
- Any additional `src/*-domain/` directories introduced later
- `src/platform/`
- `src/platform/storage/`
- `src/platform/config/`
- `src/platform/cli/`
- `src/platform/protocol/`

## Boundary comment convention

Public module entry points should include a short ownership comment:

```ts
/**
 * Owns: declarative observations, search/context ranking, sessions, dedupe, and memory lifecycle.
 * Boundary: may use platform storage/config; must not import code-index, doc-index, or Pi extension modules.
 */
```

Keep comments focused on ownership and dependency boundaries. Detailed rationale belongs in `docs/ARCHITECTURE.md` or `docs/ARCHITECTURE_MODULARIZATION.md`.
