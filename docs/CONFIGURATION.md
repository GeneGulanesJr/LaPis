# Configuration Guide

This guide covers configuration for the LaPis memory layer extension.

## Setup

LaPis does not install npm dependencies during Pi startup or database access. Install dependencies explicitly when running from a local checkout:

```bash
npm install
```

If the local SQLite/libSQL dependency is missing, LaPis reports the missing dependency and the command to run instead of attempting a runtime install.

## Config File

LaPis reads optional JSONC configuration from:

```text
~/.pi/memory/config.jsonc
```

Supported settings include:

```jsonc
{
  "db_path": "~/.pi/memory/memory.db",
  "wal_autocheckpoint": 1000,
  "busy_timeout_ms": 30000,
  "busy_retry_max": 5,
  "ranking": {
    "fts_relevance": 0.4,
    "recency": 0.3,
    "trust": 0.15,
    "recall": 0.15
  },
  "dedup": {
    "auto_merge_threshold": 0.85,
    "warning_threshold": 0.6
  },
  "compact_every_n_sessions": 5,
  "context_limit": 5,
  "tier_config_path": "~/.pi/memory/tier.jsonc",
  "async_index_file_threshold": 500,
  "output_compression": {
    "enabled": true,
    "min_chars": 2000,
    "min_savings_percent": 30
  }
}
```

### Setting reference

| Key                         | Default                              | Purpose                                                                 |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `db_path`                   | `~/.pi/memory/memory.db`             | SQLite database path. `~` is expanded.                                  |
| `wal_autocheckpoint`        | `1000`                               | Pages between WAL checkpoints.                                          |
| `busy_timeout_ms`           | `30000`                              | SQLite busy timeout in milliseconds.                                    |
| `busy_retry_max`            | `5`                                  | Maximum retries when the database reports `SQLITE_BUSY`.                |
| `ranking.*`                 | see above                            | Hybrid search weights (must sum to 1.0).                                |
| `dedup.*`                   | see above                            | Similarity thresholds for auto-merge and warning.                       |
| `compact_every_n_sessions`  | `5`                                  | Sessions between compaction passes.                                     |
| `context_limit`             | `5`                                  | Default context-packet size for the `context` command.                  |
| `tier_config_path`          | `~/.pi/memory/tier.jsonc`            | Path to the tool tier configuration file.                               |
| `async_index_file_threshold` | `500`                                | File count at which `index-repo` auto-switches to async.                |
| `output_compression.*`      | `{ enabled: true, min_chars: 2000, min_savings_percent: 30 }` | Output compression defaults for the `run` subcommand and extension tool guardrails. |

## Tool Tier Configuration

LaPis supports tool access tiers to control which commands are available to the Pi agent. The tier is configured in the file specified by `tier_config_path` (defaults to `~/.pi/memory/tier.jsonc`):

```jsonc
{
  "tier": "full"  // "core", "standard", or "full"
}
```

### Tier Definitions

| Tier      | Commands included                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `core`    | `search`, `save`, `context`, `search-code`, `get-code-source`, `preflight`, `agent-pack`, `importance`, `outline`, `winnow`, `dream` |
| `standard`| All core commands + `complexity`, `dead-code`, `hotspots`, `blast-radius`, `call-hierarchy`, `cycles`, `coupling` |
| `full`    | All commands unrestricted                                                                               |

## HTTP Server Configuration

The optional HTTP server can be started via the `serve` command:

```bash
node memory-store.js serve [--host HOST] [--port PORT] [--api-key KEY]
```

| Option      | Default     | Description                                                                 |
| ----------- | ----------- | --------------------------------------------------------------------------- |
| `--host`    | `127.0.0.1` | Bind address. Use `0.0.0.0` or `::` to expose on the network.               |
| `--port`    | `9100`      | Port number.                                                                |
| `--api-key` | (unset)     | Require `x-api-key` or `Authorization: Bearer` on all routes except `/health`. |

### HTTP authentication

When an API key is configured, every route except `GET /health` requires one of:

- Header: `x-api-key: <your-key>`
- Header: `Authorization: Bearer <your-key>`

Configure the key via (first match wins):

1. CLI flag: `--api-key`
2. Environment variable: `LAPIS_HTTP_API_KEY`
3. Config file: `http_api_key` in `~/.pi/memory/config.jsonc`

**Security defaults:**

- `127.0.0.1` without a key remains open to local processes (intentional for single-user dev).
- Binding to `0.0.0.0` or `::` **without** an API key is refused at startup.
- When exposed on the network, always set an API key or place the server behind a reverse proxy with auth.

Binding to an unrestricted address exposes memory APIs on your network. Use only on trusted networks or behind a proxy.

## Claude Code bridge configuration

These environment variables tune the Claude Code hooks bridge. They are optional; defaults work for most installs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_PROJECT_DIR` | (unset) | When set by Claude Code, overrides hook payload `cwd` for repo matching and context injection. Also honored by the MCP server. |
| `LAPIS_SESSION_TTL_HOURS` | `24` | Age threshold for automatic stale-session sweep on `SessionStart` and manual `lapis claude-code gc`. |
| `LAPIS_DAEMON_URL` | (derived from lockfile) | Force hook handlers to POST dispatch to this URL (e.g. `http://127.0.0.1:9100`). |
| `LAPIS_DAEMON_LOCKFILE` | `~/.pi/memory/claude-daemon.json` | Override daemon lockfile path. |

### Per-session hook state (Claude Code only)

Claude Code spawns a fresh process per hook event. LaPis persists session-scoped fields separately from the main database:

```text
~/.pi/memory/claude-sessions/<claude_session_id>.json
```

Fields include `sessionId`, `turnCount`, `editedFiles`, `exploredFiles`, `memoriesSavedThisSession`, `pendingRecallFeedback`, and related counters. The main SQLite database (`db_path`) stores observations, indexes, and trust data shared across Pi, MCP, and Claude Code.

Sweep stale files manually:

```bash
lapis claude-code gc [--max-age-hours N]
```

See [`CLAUDE_CODE.md`](CLAUDE_CODE.md) for install, hook mapping, and troubleshooting.

## What Gets Stored

LaPis stores data locally in the configured SQLite database. It can store:

- Explicit memories saved through `memory-save` or the `save` CLI command.
- Session lifecycle records, summaries, recall metadata, and context ranking signals.
- Edited-file checkpoints containing file paths and brief progress metadata.
- Auto-detected assistant decisions, bugfix notes, discoveries, and constraints inferred from assistant messages.
- Indexed code/documentation metadata for repositories explicitly indexed with `memory-code` and `memory-doc`.
- Code index diagnostics, including parse errors, zero-symbol files, freshness, and index health signals.
- Symbol links and trust scores used to reduce confidence when linked code changes.
- Aurex domain data: missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings, sessions, costs, checkpoints, and settings (when using the HTTP server).

## Dream Cycle

The Dream Cycle is configured through the session cadence settings above and runs memory-quality cleanup after session end. See [`DREAM_CYCLE.md`](DREAM_CYCLE.md) for the cleanup policy and stale-memory criteria.

## Glossary

- **Agent** — An autonomous process that can store and retrieve memories.
- **Context Window** — The limited amount of information an AI can process at once.
- **Dream Cycle** — Periodic cleanup that removes stale, superseded, or low-value memories.

## See Also

See [SKILL.md](SKILL.md) for the main skill documentation.
