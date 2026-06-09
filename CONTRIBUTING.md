# Contributing to LaPis

LaPis is a modular Node.js runtime plus Pi extension for persistent agent memory. Use this guide to decide where to make a change, which dependency boundary to respect, and which checks to run before opening a PR.

## Baseline verification commands

Run these from a clean checkout before submitting a PR:

```bash
# 1. Full Vitest suite
npm test

# 2. Smoke-test every CLI command as a subprocess
node test/smoke-cli.js

# 3. Lint and formatting checks
npm run check
```

All three should pass before merge. Documentation-only changes may not need the full smoke suite during iteration, but extraction/refactor PRs must run every command above.

## Where to add a feature

Start with the feature area, then add code in the owning module. If a change appears to need two feature modules directly importing each other, stop and add a small interface or route it through the owning integration module instead.

| If you are changing...                                                                                                                                      | Add or update code in...                                       | Notes                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Observation CRUD, memory search, context loading, sessions, recall, dedupe, compaction, or workspaces                                                       | `src/memory-domain/`                                           | This module owns declarative memory and must not depend on code/doc parsers.                          |
| Repository registration, file scanning, parser selection, symbol extraction, edge extraction, incremental indexing, or source retrieval                     | `src/code-index/`                                              | This module writes/serves the code-index read model; it must not include memory ranking logic.        |
| Import/call graphs, blast radius, dead code, complexity, hotspots, cycles, PageRank, coupling, signal chains, layer violations, query winnowing, or PR risk | `src/code-analysis/`                                           | Analysis consumes code-index read models and git metrics; it must not depend on Pi extension state.   |
| Markdown indexing, section search, backlinks, broken links, glossary terms, tutorial paths, code examples, or doc analytics                                 | `src/doc-index/`                                               | Documentation features are independent; coverage may use only a narrow code-symbol lookup.            |
| Trust decay/recovery or memory-to-code-symbol relationship updates                                                                                          | `src/trust-sync/`                                              | This is the integration boundary between declarative memory and indexed code.                         |
| HTTP server, REST endpoints, Aurex domain handlers (missions, milestones, units, contracts, verdicts, broadcasts, findings, costs, settings)                | `src/http/`                                                    | Handlers should be thin — parse params, call repositories, format JSON. No business logic or raw SQL. |
| CLI subcommand parsing/routing                                                                                                                              | `src/cli/commands/` and `src/cli/gateway.js`                   | Routers should delegate to feature services and avoid embedding business logic.                       |
| JSON envelopes, compact output, LLM-facing transformations, or response metadata                                                                            | `src/platform/protocol/`                                       | Presentation belongs at platform/protocol boundaries, not inside feature services.                    |
| Database access helpers or feature repositories                                                                                                             | `src/platform/storage/` and `data-access/`                     | Prefer repository interfaces over ad hoc SQL in feature modules.                                      |
| Pi lifecycle hooks, tool schemas, repo detection, native health checks, or tool result formatting                                                           | `extensions/memory-layer/`                                     | The extension is an adapter/composition layer; keep backend behavior in feature modules.              |
| Agent-facing coding intelligence, preflight checks, agent-pack planning, audit-diff, or symbol enrichment                                                   | `src/agent-intel/`                                             | Read-only orchestration layer. Must not mutate memory or code indexes.                                |
| Output compression, command classification, token estimation, or savings tracking                                                                           | `src/token-saver/`                                             | Standalone module with no feature service dependencies.                                               |
| Memory observability dashboard or health statistics                                                                                                         | `src/cli/commands/dashboard.js` and `data-access/dashboard.js` | Dashboard is a CLI/router concern; depends on data-access helpers only.                               |
| Rust code-intelligence experiments or Crosshash engine work                                                                                                 | `crosshash/`                                                   | Keep Crosshash behind a process/API boundary until it becomes the canonical backend.                  |

For the authoritative table of module ownership, entry points, and allowed dependencies, update and consult [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md).

## Project structure

```text
memory-store.js          # CLI entry point that delegates to cli.js
cli.js                   # Runtime command dispatch setup
extensions/memory-layer/ # Pi extension composition root, hooks, host client, and tools
src/cli/                 # CLI gateway and feature command routers
src/http/                # Optional HTTP server (Aurex domain + code endpoints)
src/memory-domain/       # Declarative memory feature module
src/code-index/          # Code indexing and source retrieval feature module
src/code-analysis/       # Code intelligence and analysis feature module
src/doc-index/           # Documentation indexing and doc intelligence feature module
src/agent-intel/         # Agent intelligence and preflight orchestration (read-only)
src/token-saver/         # Output compression and token savings tracking (standalone)
src/trust-sync/          # Memory/code trust integration feature module
src/platform/            # Shared storage/protocol/platform adapters and repository construction
data-access/             # Repository-style SQL access modules used by legacy/runtime code
test/                    # Vitest unit/integration tests and CLI smoke tests
crosshash/               # Rust code-intelligence workspace
```

## Dependency boundaries

LaPis is a modular monolith: one package, many independently testable feature modules. The target dependency flow is:

```text
Pi extension adapters
  -> CLI/API command gateway
  -> feature services
  -> platform storage/protocol helpers
```

Follow these rules when adding or moving code:

1. `extensions/*` may depend on backend clients and formatting adapters, but not raw SQL or parser internals.
2. `memory-domain` may depend on storage, config, and ranking constants, but not code/doc parsers.
3. `code-index` may depend on parser, filesystem, hashing, and storage helpers, but not memory observation ranking.
4. `code-analysis` may depend on code-index read repositories and git metrics, but not Pi extension state.
5. `doc-index` may depend on Markdown/doc storage; documentation coverage may depend only on a narrow code-symbol lookup.
6. `trust-sync` is the only module that should coordinate memory observations with code symbol tables.
7. `platform/protocol` owns `_meta`, compact/auto output, and LLM-facing transformations.
8. `src/http/` may depend on platform repositories and feature services, but should not contain business logic or raw SQL.
9. Crosshash should stay behind a command/API boundary until it fully replaces the JavaScript code-intelligence path.
10. `agent-intel` may depend on code-index read model, memory-domain search, and doc-index, but must not mutate memory or code indexes.
11. `token-saver` is standalone; it may not depend on feature service internals or Pi extension state.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the concise architecture overview and [`docs/ARCHITECTURE_MODULARIZATION.md`](docs/ARCHITECTURE_MODULARIZATION.md) for the detailed extraction rationale.

## Adding or changing modules

When a PR adds, removes, renames, or changes the dependency boundary of a module:

1. Update [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md).
2. Add or update the module-boundary comment in the module entry point.
3. Add unit tests that exercise the feature module without starting the Pi extension when practical.
4. Add integration tests against a temporary SQLite database for storage behavior.
5. Add or update CLI/router tests only for argument mapping and command delegation.
6. Keep user-facing formatting at extension or protocol boundaries instead of feature services.

## Extraction/refactor PR requirements

PRs labeled `architecture` or `refactor`, or PRs that touch modularization code, have additional requirements:

1. **Full test suite must pass** — no exceptions.
2. **Smoke CLI tests must pass** — every command that moved to a new router must still work.
3. **Lint and format checks must pass** — run `npm run check`.
4. **Legitimate test behavior changes must be documented** — if an extraction changes expected behavior, update the test in the same PR and explain why in the PR description.
5. **Module map must stay current** — update `docs/MODULE_MAP.md` when module ownership or boundaries change.

## Test commands reference

| Command                  | What it checks                                          | When to run                  |
| ------------------------ | ------------------------------------------------------- | ---------------------------- |
| `npm test`               | Full Vitest suite, including unit and integration tests | Every PR                     |
| `node test/smoke-cli.js` | Every CLI subcommand via subprocess                     | Every extraction/refactor PR |
| `npm run lint`           | oxlint static analysis                                  | Every PR                     |
| `npm run format:check`   | oxfmt formatting check                                  | Every PR                     |
| `npm run check`          | Lint + format combined                                  | Every PR                     |

## CI

GitHub Actions runs on pushes and PRs to `main`:

- `test.yml` installs dependencies, runs lint, runs the full test suite, runs smoke CLI tests, and runs post-smoke index-repo/index-docs verification.
- `crosshash-ci.yml` runs Rust lint/test coverage for the `crosshash/` workspace.
