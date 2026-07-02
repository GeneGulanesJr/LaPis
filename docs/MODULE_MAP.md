# Module Map

This document is the source of truth for LaPis module ownership. Update it whenever a PR adds, removes, renames, or changes the dependency boundary of a module.

## Source modules

| Feature area | Module directory | Entry point | Owns | Allowed dependencies | Must not depend on |
| --- | --- | --- | --- | --- | --- |
| CLI command gateway | `src/cli/` | `src/cli/gateway.js` | Command map composition and feature router registration. | Feature command routers and feature service modules. | Raw feature implementation details beyond router delegation; Pi extension state. |
| Declarative memory domain | `src/memory-domain/` | `src/memory-domain/index.js` | Observations, memory search, context loading, sessions, recall logging, dedupe, compaction, and workspaces. | Storage/repository helpers, configuration, ranking constants, project identity. | Code/doc parsers, code-analysis internals, Pi extension state. |
| Code indexing and retrieval | `src/code-index/` | `src/code-index/index.js` | Repository registration, scanning, language/parser selection, symbol extraction, import/call edge extraction, incremental indexing, and source retrieval. | Filesystem utilities, parser registry, hashing, code-index storage repositories. | Memory observation ranking, doc-index internals, Pi extension state. |
| Code analysis and intelligence | `src/code-analysis/` | `src/code-analysis/index.js` | Import/call graph queries, blast radius, dead code, complexity, hotspots, cycles, importance, coupling, hierarchy, signal chains, layer violations, query winnowing, and risk analysis. | Code-index read model/repositories, git metrics, analysis formatters. | Pi extension state, memory observation CRUD, parser write-path internals. |
| Documentation indexing and intelligence | `src/doc-index/` | `src/doc-index/index.js` | Markdown parsing, doc repository indexing, section search, backlinks, broken links, glossary terms, tutorial paths, code examples, stale/duplicate/orphan analytics, and doc coverage reports. | Markdown/doc storage repositories; a narrow code-symbol lookup for coverage only. | Memory-domain internals, code-analysis internals, Pi extension state. |
| Trust synchronization | `src/trust-sync/` | `src/trust-sync/index.js` | Memory-to-code-symbol links, related memory lookup, trust policy, and code-change detection for trust updates. | Memory repositories, code-symbol repositories, git/code change metadata. | Unrelated feature internals; direct doc-index behavior. |
| Agent intelligence | `src/agent-intel/` | `src/agent-intel/preflight.js` (primary) plus siblings `agent-pack.js`, `blast.js`, `dupes.js`, `symbol-enrichment.js`, `audit-diff.js`, `runtime-ingest.js`, `stale-flags.js` | Agent-facing coding intelligence orchestration: preflight checks, agent-pack planning, audit-diff, blast radius orchestration, dupes, runtime-ingest, stale-flags, and symbol-enrichment. | Code-index read model, memory-domain search, doc-index. | Pi extension state, raw SQL, mutation of memory or code indexes. |
| Token saver | `src/token-saver/` | `src/token-saver/index.js` | Output compression, command classification, token estimation, and savings tracking for CLI commands. | None beyond Node stdlib. | Feature service internals, Pi extension state. |
| HTTP server (Aurex domain) | `src/http/` | `src/http/server.js` | REST API server for Aurex domain model (missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings, sessions, costs, retry, compression, checkpoints, settings) and code indexing/analysis endpoints. Route matching, JSON body parsing, error helpers. | Platform repositories (`aurex`), `db.js` for startup. | Business logic, raw SQL, Pi extension state. |
| Platform services | `src/platform/` | `src/platform/storage/index.js`, `src/platform/protocol/envelope.js` | Shared storage composition, repository construction (observations, code-index, doc-index, memory, trust-sync, analytics, aurex), protocol envelopes, compact output, and LLM-facing transformations. | Database adapters, repository factories, typed feature results, constants. | Feature business logic, Pi extension state, command parsing. |

## Extension and support modules

| Area | Directory | Owns | Boundary |
| --- | --- | --- | --- |
| Pi extension integration | `extensions/memory-layer/` | Pi hook registration, tool schemas, context injection, passive capture, trust-sync hooks, project detection, native dependency health checks, and tool result formatting. | Adapter layer only; do not add raw SQL, parser internals, or backend feature business logic here. |
| Shared hook engine | `src/hooks-engine/` | Transport-agnostic hook primitives for context assembly, prompt classification, passive capture, guardrail evaluation helpers, project detection, transcript/session summary parsing, and tool-response parsing. | Pure JavaScript core only. Do not depend on Pi extension APIs, Claude Code process state, raw SQL, or feature command routers. |
| Claude Code bridge | `src/claude-code/` | Claude Code hook routing, per-session state persistence, lifecycle handlers, PreToolUse/PostToolUse guardrails, and process-boundary state mirroring for MCP memory tools. | Adapter layer only; use `src/hooks-engine/` for shared logic and `dispatch-client` for feature commands. Do not import Pi extension state or mutate feature stores directly. |
| Memory dashboard | `src/cli/commands/dashboard.js`, `data-access/dashboard.js` | Memory observability dashboard: health, statistics, and index quality overview. | Data-access helpers only. Do not depend on feature service internals or Pi extension state. |
| Legacy/runtime CLI entry | `memory-store.js`, `cli.js`, `commands/` | Backwards-compatible command entry points and legacy command modules while extraction continues. | Prefer moving new feature behavior into `src/` modules and routing through `src/cli/`. |
| Data access helpers | `data-access/` | Repository-style SQL helpers used by current runtime code. | Keep SQL ownership clear; do not mix presentation formatting into repositories. |
| Crosshash Rust engine | `crosshash/` | Rust code-intelligence engine experiments and future backend work. | Keep behind a command/API boundary until it replaces the JavaScript code-intelligence path. |

## When to update this file

Update this module map when a change:

- Adds or removes a top-level `src/` feature module.
- Renames a module, entry point, or feature router.
- Moves ownership of a command, table, repository, parser, formatter, or analysis routine.
- Changes which modules are allowed to depend on each other.
- Adds a new integration boundary between two feature modules.

Also update the matching module-boundary comment in the relevant entry point so the code and docs stay aligned.
