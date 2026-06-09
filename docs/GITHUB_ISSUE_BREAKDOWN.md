# GitHub issue breakdown for modularization

These issue drafts break `docs/ARCHITECTURE_MODULARIZATION.md` into implementation-sized GitHub issues. They are ordered so each issue can reduce coupling without requiring a full rewrite, while keeping LaPis as **one installed Pi extension**.

> Note: These are issue-ready drafts. In this environment, GitHub issue creation could not be completed because the GitHub CLI is not installed, there is no configured git remote, and no GitHub token is available in the environment.

## Issue 1: Refactor the single Pi extension into a thin composition root, hook adapters, and tool adapters

**Labels**: `architecture`, `pi-extension`, `refactor`

### Motivation

`extensions/memory-layer/index.ts` currently owns lifecycle hooks, tool schemas, command client logic, result formatting, repo caching, native dependency checks, and module-level reliability state. This increases blast radius: a bug in a formatter or repo-cache helper can affect unrelated session hooks or tools.

### Scope

- Create an extension host layout:
  - `extensions/memory-layer/host/memory-client.ts`
  - `extensions/memory-layer/host/project-detector.ts`
  - `extensions/memory-layer/host/repo-cache.ts`
  - `extensions/memory-layer/host/native-health.ts`
  - `extensions/memory-layer/hooks/session-lifecycle.ts`
  - `extensions/memory-layer/hooks/context-injection.ts`
  - `extensions/memory-layer/hooks/passive-capture.ts`
  - `extensions/memory-layer/hooks/tool-guardrails.ts`
  - `extensions/memory-layer/hooks/trust-sync.ts`
  - `extensions/memory-layer/tools/memory-tools.ts`
  - `extensions/memory-layer/tools/code-tools.ts`
  - `extensions/memory-layer/tools/doc-tools.ts`
  - `extensions/memory-layer/tools/format-code-result.ts`
  - `extensions/memory-layer/tools/format-doc-result.ts`
- Keep `extensions/memory-layer/index.ts` as the **single** Pi extension registration/composition root.
- Preserve existing runtime behavior and public tool names.
- Add unit tests for moved helpers where practical.

### Acceptance criteria

- `index.ts` remains the only LaPis `ExtensionAPI` entrypoint and mainly registers hooks, tools, and commands.
- Hook modules can be tested without booting the whole Pi extension.
- Tool formatters are pure functions with focused tests.
- A failure in a feature adapter, such as doc tooling, does not prevent unrelated memory tools from registering in the same extension.
- Existing extension tool names and command names remain backward compatible.

---

## Issue 2: Split `memory-store.js` command dispatch into feature routers

**Labels**: `architecture`, `cli`, `refactor`

### Motivation

`memory-store.js` is the current backend monolith. It handles observation memory, sessions, workflows, code indexing, code analysis, doc indexing, git analysis, trust sync, response metadata, wire formatting, JSON output, and command dispatch in one file.

### Scope

- Introduce feature command routers, for example:
  - `src/cli/commands/memory.ts`
  - `src/cli/commands/workflow.ts`
  - `src/cli/commands/code-index.ts`
  - `src/cli/commands/code-analysis.ts`
  - `src/cli/commands/docs.ts`
  - `src/cli/commands/trust.ts`
  - `src/cli/commands/maintenance.ts`
- Keep the existing `memory-store.js` CLI entry point as a compatibility wrapper while routers are extracted.
- Move usage text and command validation into the relevant router.
- Preserve command names and output shape.

### Acceptance criteria

- `memory-store.js` no longer contains all command implementations inline.
- Each router can be tested with mocked service dependencies.
- Existing CLI commands continue to work.
- CLI argument validation remains at the command boundary, not in domain services.
- No feature router imports unrelated feature implementation details.

---

## Issue 3: Introduce storage repositories and feature-owned migration boundaries

**Labels**: `architecture`, `storage`, `sqlite`

### Motivation

All feature areas currently share one SQLite database and a single schema file. A single DB is fine for deployment simplicity, but feature ownership is unclear and modules can accidentally mutate unrelated tables.

### Scope

- Keep one SQLite DB file initially.
- Introduce repository interfaces by feature area:
  - memory repositories,
  - workflow repositories,
  - code-index repositories,
  - doc-index repositories,
  - trust-sync repositories,
  - analytics repositories.
- Organize migrations/schema sections by feature ownership.
- Ensure feature modules depend on repositories, not raw SQL helpers.
- Keep `db.js` or its successor as platform infrastructure only.

### Acceptance criteria

- Feature services do not call global SQL helpers directly.
- Repository interfaces make table ownership explicit.
- Tests can use temporary SQLite databases or in-memory fixtures.
- Schema organization makes it clear which module owns each table.
- Existing DB initialization remains backward compatible.

---

## Issue 4: Extract declarative memory and session memory into `memory-domain`

**Labels**: `architecture`, `memory`, `refactor`

### Motivation

Observation CRUD, search, context loading, sessions, prompt capture, dedupe, recall, compaction, dream cleanup, and workspaces are the core memory product. They should not depend on code indexing, docs, Pi hooks, or CLI formatting.

### Scope

- Create `src/memory-domain/` with modules such as:
  - `observations.ts`
  - `search.ts`
  - `context.ts`
  - `sessions.ts`
  - `recall.ts`
  - `dedupe.ts`
  - `compaction.ts`
  - `workspaces.ts`
- Return typed domain results instead of CLI envelopes.
- Move memory-specific ranking and dedupe logic into this domain.
- Keep CLI/extension response formatting outside the domain.

### Acceptance criteria

- Memory-domain has no dependency on code parser/indexer/doc parser internals.
- Observation save/search/context/get/update/delete behavior is preserved.
- Unit tests cover ranking, dedupe, recall, and context behavior.
- Integration tests run against a temporary SQLite DB.
- CLI commands and Pi tools become thin adapters over memory-domain services while still being registered by the main LaPis extension.

---

## Issue 5: ~~Extract procedural workflow memory into `workflow-memory`~~ — SUPERSEDED by #167

**Labels**: `architecture`, `memory`, `workflow`
**Status**: Withdrawn — the procedural memory feature was removed in commit `a2b151b` (Issue #167, "remove dead procedural memory feature") because the underlying `procedural_memory` table had zero rows and was not in use. The CLI commands `save-workflow`, `record-step`, `step-outcome`, and `get-workflow` no longer exist, and the corresponding `src/workflow-memory/`, `src/cli/commands/workflow.js`, `commands/workflow.js`, `src/platform/storage/repositories/workflow.js`, and `test/workflow-memory.test.js` files were deleted. The decisions/trust/auto-capture/preflight subsystems already cover the use case this issue was originally intended to address.

**Smoke test note**: Any smoke test referencing these commands (e.g. `--help lists save-workflow`) is stale and should be removed.

### Original motivation (kept for historical context)

Procedural workflows have a distinct data model from declarative observations. They track named workflows, ordered steps, outcomes, attempts, and workarounds. They should not be coupled to observation ranking or context search.

### Original scope (no longer applicable)

- Create `src/workflow-memory/` with modules such as:
  - `workflows.ts`
  - `steps.ts`
  - `scoring.ts`
- Move commands currently represented by `save-workflow`, `record-step`, `step-outcome`, and `get-workflow` behind a workflow service.
- Share only storage and project/workspace identity with declarative memory.

### Original acceptance criteria (no longer applicable)

- Workflow memory can be tested without observation search/context code.
- Workflow commands preserve current CLI behavior.
- Step success, attempts, and workarounds are covered by focused tests.
- The module has no dependency on code indexing or doc indexing.

---

## Issue 6: Extract code indexing and source retrieval into `code-index`

**Labels**: `architecture`, `code-index`, `tree-sitter`, `refactor`

### Motivation

Repository scanning, parser selection, symbol extraction, import/call edge extraction, incremental reindexing, and source retrieval should be a standalone feature. Code indexing should not know about memory trust policy or LLM response formatting.

### Scope

- Create `src/code-index/` with modules such as:
  - `repos.ts`
  - `scanner.ts`
  - `parser-registry.ts`
  - `symbol-extractor.ts`
  - `edge-extractor.ts`
  - `incremental-indexer.ts`
  - `source-retrieval.ts`
- Define a stable code index read model:
  - `CodeRepository`
  - `CodeFile`
  - `CodeSymbol`
  - `ImportEdge`
  - `CallEdge`
  - `ComplexityMetric`
- Keep `index-repo`, `reindex-repo`, `search-code`, `get-code-source`, `list-code-repos`, and `remove-code-repo` compatible.

### Acceptance criteria

- Code indexing can run as an internal feature without loading memory-domain, doc-index, or trust-sync services.
- Parser registry and symbol extraction have focused tests.
- Incremental reindexing has tests for changed, added, and deleted files.
- Source retrieval remains byte-accurate.
- Indexing writes through a `CodeIndexRepository` interface.

---

## Issue 7: Extract code analysis into analyzers over the code-index read model

**Labels**: `architecture`, `code-analysis`, `refactor`

### Motivation

Code analysis should consume a stable code-index read model and return typed analysis DTOs. It should not depend on Pi extension state, memory observations, or incidental parser schema details.

### Scope

- Create `src/code-analysis/` with modules such as:
  - `graph.ts`
  - `impact.ts`
  - `quality.ts`
  - `git-metrics.ts`
  - `ast-patterns.ts`
  - `risk.ts`
  - `query-winnow.ts`
  - `metadata.ts`
  - `formatters/compact.ts`
  - `formatters/llm.ts`
- Move or wrap analysis features:
  - import graph,
  - call hierarchy,
  - blast radius,
  - dead code,
  - complexity,
  - hotspots,
  - cycles,
  - importance,
  - coupling,
  - extraction candidates,
  - hierarchy,
  - signal chains,
  - layer violations,
  - winnow,
  - untested symbols,
  - PR risk.
- Keep response metadata and compact formatting at the protocol/presentation boundary.

### Acceptance criteria

- Analyzers depend on code-index read repositories and git providers only.
- Each analyzer has focused unit tests.
- Existing analysis CLI commands preserve names and output compatibility.
- Failure in one analyzer returns a scoped error and does not break other analyzers.
- Complexity computation behavior is covered to prevent empty/missing complexity regressions.

---

## Issue 8: Extract documentation indexing and documentation intelligence into `doc-index`

**Labels**: `architecture`, `docs`, `doc-index`, `refactor`

### Motivation

Documentation indexing has its own model: doc repos, files, sections, links, glossary terms, and code blocks. It should be a peer feature to code indexing, not an incidental branch of memory-store dispatch.

### Scope

- Create `src/doc-index/` with modules such as:
  - `repos.ts`
  - `markdown-parser.ts`
  - `sections.ts`
  - `links.ts`
  - `glossary.ts`
  - `examples.ts`
  - `analytics.ts`
- Move or wrap doc features:
  - `index-docs`,
  - `reindex-docs`,
  - `doc-search`,
  - `doc-outline`,
  - `backlinks`,
  - `broken-links`,
  - `glossary`,
  - `tutorial-path`,
  - `code-examples`,
  - `doc-orphans`,
  - `doc-coverage`,
  - `stale-pages`,
  - `doc-duplicates`.
- Keep doc coverage dependent only on a narrow `CodeSymbolLookup` interface.

### Acceptance criteria

- Doc indexing can run as an internal feature without memory-domain or code-analysis.
- Markdown parsing, links, glossary, examples, and analytics have focused tests.
- Doc coverage does not directly mutate or depend on code-index internals.
- Existing doc CLI/tool behavior is preserved.

---

## Issue 9: Isolate trust sync as the only explicit memory/code integration module

**Labels**: `architecture`, `trust`, `memory`, `code-index`

### Motivation

Trust sync intentionally bridges memories and code symbols. Because it is cross-cutting, it should be small, explicit, and the only module allowed to mutate both memory tables and code-link/trust tables.

### Scope

- Create `src/trust-sync/` with modules such as:
  - `symbol-links.ts`
  - `trust-policy.ts`
  - `change-detector.ts`
  - `related-memory.ts`
- Move or wrap commands:
  - `link-symbol`,
  - `auto-link`,
  - `adjust-trust`,
  - `record-recall`,
  - `stale-links`,
  - `sync-code-trust`,
  - `trust-recovery`,
  - `related`,
  - `symbol-cluster`.
- Depend on memory and code-index through interfaces only.

### Acceptance criteria

- Trust sync is the only module that coordinates memory records and code symbol links.
- Trust policy can be tested independently from git hooks and Pi extension state.
- Git-triggered trust sync calls this module through a small adapter.
- Related-memory lookup remains backward compatible.
- Failure in trust sync does not block basic memory save/search.

---

## Issue 10: Move protocol, response metadata, and compact formatting to platform boundary

**Labels**: `architecture`, `protocol`, `formatting`

### Motivation

Result envelopes, freshness/confidence metadata, compact response stripping, and LLM-facing formatting are currently close to data retrieval and command dispatch. Domain services should return typed results; adapters should format them.

### Scope

- Create `src/platform/protocol/` with modules such as:
  - `envelope.ts`
  - `compact-format.ts`
  - `llm-format.ts`
- Move response metadata and wire formatting out of feature services.
- Ensure CLI/API/Pi extension adapters own presentation concerns.
- Preserve existing `_meta`, compact, auto, and JSON output behavior.

### Acceptance criteria

- Domain services return typed results without `_meta` wrapping.
- CLI/API/extension boundaries apply envelopes and compact formatting.
- Existing compact format tests still pass.
- Large analysis/doc outputs still support auto compacting.

---

## Issue 11: Decide and document the Crosshash migration strategy

**Labels**: `architecture`, `crosshash`, `planning`

### Motivation

The repo contains both the Node/Pi runtime and the Rust Crosshash workspace. Crosshash is already closer to the desired modular architecture for code intelligence, but the repo should avoid maintaining two implicit code-intelligence architectures indefinitely.

### Scope

- Decide whether Crosshash becomes the canonical internal code-intelligence backend behind the single LaPis extension or remains an experimental/parallel engine.
- Document the integration boundary:
  - process boundary,
  - API boundary,
  - MCP boundary,
  - or library boundary.
- Identify duplicated concepts between JS code indexing/analysis and Crosshash.
- Create follow-up migration issues if Crosshash is chosen as canonical.

### Acceptance criteria

- A decision record exists in docs.
- Ownership between Node code-index/code-analysis and Crosshash is explicit.
- Future issues know whether to enhance JS modules, migrate them, or wrap Crosshash.
- Pi extension concerns stay in the main extension/adapters and are not pushed into Rust crates without a boundary decision.

---

## Issue 12: Add module-boundary and failure-isolation tests

**Labels**: `architecture`, `testing`, `reliability`

### Motivation

The modularization goal is not only cleaner files; it is feature isolation. If one feature fails, unrelated features should continue to operate.

### Scope

- Add tests that prove failures are scoped:
  - doc-index failure does not break memory save/search,
  - passive capture failure does not block session startup,
  - trust sync failure does not block basic memory tools,
  - one code analyzer failure does not break other analyzers,
  - formatter failure returns a scoped adapter error.
- Add import/dependency boundary checks where practical.
- Add tests for CLI/router argument mapping once routers exist.

### Acceptance criteria

- Each major feature module has unit tests independent of the Pi extension.
- Each major feature has at least one failure-mode test.
- Tests enforce no forbidden cross-module imports where practical.
- CI can run feature tests without requiring a full Pi session, while integration tests still verify registration through the single extension entrypoint.
