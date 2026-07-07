# LaPis Documentation Index

This page is the entry point to the LaPis documentation. Use it to find the right doc for a topic and to understand how the three integration transports relate.

## Integration transports

LaPis ships one backend with three client integrations:

| Transport | Entry point | Config | Hooks & guardrails |
| --- | --- | --- | --- |
| **Pi extension** (primary) | `pi install git:github.com/GeneGulanesJr/LaPis` | Pi extension registry | Full — in-process hooks, tools, session lifecycle |
| **MCP server** (tools only) | `lapis mcp` (or `lapis-mcp mcp`) | Host-specific MCP config | Tool surface only |
| **Claude Code** (MCP + hooks) | `lapis claude-code install` | `.mcp.json` + `.claude/settings.json` | Full parity with Pi via hook bridge |

Shared hook logic lives in [`src/hooks-engine/`](../src/hooks-engine/) and is consumed by both the Pi extension and the Claude Code bridge. See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## Verified test counts

Regenerate after doc or test changes:

```bash
npm test
```

As of the Claude Code integration (issue #205) landing, the dedicated bridge suites are:

```bash
npx vitest run test/claude-code test/hooks-engine
```

That subset should report **18** test files and **279** passing tests. The full `npm test` suite includes integration tests that require a working `better-sqlite3` native module and writable temp databases.

## Documentation map

| Topic | Doc |
| --- | --- |
| Top-level project overview | [`README.md`](../README.md) |
| Contributor workflow and checks | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Architecture overview | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) |
| Module ownership and boundaries | [`docs/MODULE_MAP.md`](MODULE_MAP.md) |
| Modularization rationale | [`docs/ARCHITECTURE_MODULARIZATION.md`](ARCHITECTURE_MODULARIZATION.md) |
| GitHub issue breakdown (drafts) | [`docs/GITHUB_ISSUE_BREAKDOWN.md`](GITHUB_ISSUE_BREAKDOWN.md) |
| Full CLI command reference | [`docs/COMMANDS.md`](COMMANDS.md) |
| HTTP API and CLI usage | [`docs/API.md`](API.md) |
| Configuration file and stored data | [`docs/CONFIGURATION.md`](CONFIGURATION.md) |
| Dream Cycle (stale-memory cleanup) | [`docs/DREAM_CYCLE.md`](DREAM_CYCLE.md) |
| Step-by-step usage tutorial | [`docs/TUTORIAL.md`](TUTORIAL.md) |
| Async code indexing | [`docs/code-indexing.md`](code-indexing.md) |
| Extension skill overview | [`docs/SKILL.md`](SKILL.md) |
| **MCP server** (tools-only transport) | [`docs/MCP.md`](MCP.md) |
| **Claude Code CLI integration** (MCP + hooks) | [`docs/CLAUDE_CODE.md`](CLAUDE_CODE.md) |
| Memory layer skill (authoritative) | [`../skills/memory-layer/SKILL.md`](../skills/memory-layer/SKILL.md) |
| Token efficiency benchmark | [`../bench/README.md`](../bench/README.md) |
| Architecture diagram (interactive) | [`docs/diagrams/lapis-architecture.html`](diagrams/lapis-architecture.html) |
| Module boundaries diagram (interactive) | [`docs/diagrams/lapis-module-boundaries.html`](diagrams/lapis-module-boundaries.html) |
| Memory lifecycle diagram (interactive) | [`docs/diagrams/lapis-memory-lifecycle.html`](diagrams/lapis-memory-lifecycle.html) |

Static PNG exports remain under `docs/diagrams/*.png` for README embeds; prefer the HTML versions for navigation.

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
- **Maintenance**: `init`, `compact`, `dream`, `cleanup-sessions`, `dashboard`
- **Agent intel**: `preflight`, `agent-pack`, `dupes`, `enrich-symbols`, `symbol-meta`, `audit-diff`, `runtime-ingest`, `hot-symbols`, `cold-symbols`, `blast`, `stale-flags`
- **Token saver**: `run`, `token-saver-stats`, `token-saver-clear`
- **Top-level**: `serve` (HTTP), `mcp` (MCP stdio)
- **Claude Code bridge**: `claude-code install`, `uninstall`, `doctor`, `start`, `stop`, `gc`, `hook <event>`

### HTTP endpoints

Started via `node memory-store.js serve`. Defaults to `127.0.0.1:9100`. Includes `POST /dispatch` for Claude Code daemon mode. Full endpoint list in [`docs/API.md`](API.md).

## Environment and configuration

General LaPis tuning lives in `~/.pi/memory/config.jsonc` — see [`docs/CONFIGURATION.md`](CONFIGURATION.md).

Additional environment variables used by integrations:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `CLAUDE_PROJECT_DIR` | Claude Code hooks, MCP | Override project cwd for repo matching |
| `LAPIS_SESSION_TTL_HOURS` | Claude Code state store | Stale session file TTL (default 24) |
| `LAPIS_DAEMON_URL` | Claude Code dispatch client | Force daemon dispatch URL |
| `LAPIS_DAEMON_LOCKFILE` | Claude Code daemon | Override lockfile path |
| `HOME` / `USERPROFILE` | All | Base path for `~/.pi/memory/` |

Benchmark harnesses under `bench/` read `LAPIS_PATH`, `BENCH_PI_MEMORY_OFF_CMD`, and `BENCH_PI_MEMORY_ON_CMD` — documented in [`bench/README.md`](../bench/README.md).
