# Contributing to LaPis

Thanks for helping improve LaPis. This guide explains how to get a local checkout ready, where code belongs, and which architectural boundaries contributors should preserve.

## Local setup

LaPis is a Node.js package for the Pi coding agent with a local SQLite database and no cloud service requirement.

1. Install Node.js 22.5 or newer.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the main checks before opening a pull request:

   ```bash
   npm test
   npm run check
   npm run format:check
   ```

The available project scripts are defined in `package.json` and include `test`, `lint`, `lint:fix`, `format`, `format:check`, and `check`.

## Repository layout

The repository currently contains the production Node/Pi runtime, tests, docs, and the Crosshash Rust workspace:

```text
.
├── extensions/memory-layer/    # Pi extension integration layer
├── commands/                   # CLI command handlers while the backend is being modularized
├── services/                   # Current service layer for memory, code, docs, trust, and sessions
├── data-access/                # Current SQLite repository helpers
├── docs/                       # User, contributor, and architecture documentation
├── test/                       # Vitest coverage for Node modules
└── crosshash/                  # Rust code-intelligence workspace
```

The target modular backend is documented in `docs/ARCHITECTURE.md` and `docs/MODULE_MAP.md`. When a `src/` feature module exists, prefer adding new behavior there instead of expanding legacy dispatch files.

## Where to add changes

Use these ownership rules when deciding where a change belongs:

| Change type                                                                | Preferred home                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Pi hooks, tool registration, user-facing tool formatting                   | `extensions/memory-layer/`                                                |
| Observation CRUD, memory search/context, sessions, dedupe, dream cleanup   | `src/memory-domain/` or current `services/` + `data-access/` equivalent   |
| Procedural workflows and step outcomes                                     | `src/workflow-memory/` or current workflow command/data-access equivalent |
| Repository scanning, parser selection, symbol extraction, source retrieval | `src/code-index/` or current code indexing service equivalent             |
| Graph queries, blast radius, complexity, hotspots, risk, code intelligence | `src/code-analysis/` or current code analysis equivalent                  |
| Markdown indexing, backlinks, glossary, tutorial paths, doc coverage       | `src/doc-index/` or current doc indexing equivalent                       |
| Memory/code symbol links, trust policy, recall feedback, stale-link repair | `src/trust-sync/` or current trust service equivalent                     |
| SQLite lifecycle, migrations, config, CLI parsing, protocol envelopes      | `src/platform/` or current root infrastructure equivalent                 |
| Rust parser/hash/graph/API engine work                                     | `crosshash/`                                                              |

## Dependency rules

LaPis is intended to remain a modular monolith: one package, one SQLite database, one Pi extension, and independently testable internal modules. Preserve these dependency rules:

1. `extensions/*` may depend on backend clients and formatting adapters, but not raw SQL helpers or parser internals.
2. `memory-domain` may depend on storage, configuration, and ranking constants, but not code or doc parsers.
3. `workflow-memory` may depend on storage and project/workspace identity only.
4. `code-index` may depend on parser, filesystem, hashing, and storage concerns, but not memory observation ranking.
5. `code-analysis` may depend on code-index read repositories and git metrics, but not Pi extension state.
6. `doc-index` may depend on markdown/doc storage; doc coverage may depend only on a narrow code-symbol lookup interface.
7. `trust-sync` is the only module that should coordinate memory observations and code symbol tables.
8. `platform/protocol` owns response metadata, compact output, and LLM-facing transformations.
9. Crosshash should stay behind a command/API boundary until it fully replaces the JavaScript code-intelligence path.

If a change needs to cross one of these boundaries, add or update an interface at the boundary rather than importing implementation details from another feature.

## Testing expectations

For feature work, include the smallest useful combination of:

- Unit tests for pure feature logic.
- Integration tests with a temporary SQLite database when storage is involved.
- CLI/router tests that verify argument mapping without duplicating service tests.
- Failure-mode tests that prove one module returns a scoped error without breaking unrelated features.
- Regression tests for bug fixes.

Documentation-only changes do not need full runtime coverage, but they should still be reviewed for accurate paths, commands, and links.

## Documentation expectations

Update docs when you change architecture, commands, module ownership, or contributor workflow:

- `README.md` for user-facing setup and high-level development links.
- `docs/ARCHITECTURE.md` for stable architecture guidance.
- `docs/MODULE_MAP.md` for module purpose, entry points, and dependencies.
- `docs/ARCHITECTURE_MODULARIZATION.md` only when changing the modularization rationale/history.

If you add, remove, rename, or change the public entry point of a module, update `docs/MODULE_MAP.md` in the same pull request.
