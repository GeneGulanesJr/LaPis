# Tutorial

Step-by-step guide for working with LaPis memory in the Pi coding agent.

## Getting Started

LaPis is installed as a Pi extension and auto-wires on session start:

```bash
pi install git:github.com/GeneGulanesJr/LaPis
```

After installation, restart Pi. Memory operations are available through Pi's built-in tools (`memory-save`, `memory-search`, `memory-code`, `memory-doc`) and through the CLI.

## Step 1: Save a Decision

Use the Pi tool or CLI to persist an architectural decision:

```bash
# Via CLI
node memory-store.js save \
  --title "Use SQLite for storage" \
  --content "Chose SQLite for its zero-config local setup and no cloud dependencies." \
  --type decision
```

Or through Pi's `memory-save` tool during a session — the extension auto-detects many decisions from assistant messages.

## Step 2: Search Memories

Retrieve saved memories using keyword search:

```bash
node memory-store.js search --query "database choice"
```

Search uses hybrid ranking: FTS5 relevance (40%), recency (30%), trust (15%), and recall history (15%).

## Step 3: Index a Repository

Index code for semantic lookup and analysis:

```bash
node memory-store.js index-repo --path /path/to/my-project --name my-project
```

This uses web-tree-sitter (WASM) to parse JavaScript, TypeScript, TSX, Go, Python, Rust, and SQL files.

## Step 4: Analyze Code

After indexing, run analysis commands:

```bash
# Find hotspots (complexity × churn)
node memory-store.js hotspots --repo my-project

# Get dependency graph
node memory-store.js import-graph --repo my-project

# Check for dead code
node memory-store.js dead-code --repo my-project
```

## Step 5: Index Documentation

Index Markdown docs for search and intelligence:

```bash
node memory-store.js index-docs --path ./docs --name my-docs
```

Then search docs, find broken links, look up glossary terms, and more:

```bash
node memory-store.js doc-search --query "installation" --repo my-docs
node memory-store.js broken-links --repo my-docs
node memory-store.js glossary --repo my-docs --term "Dream Cycle"
```

## Step 6: Use the HTTP Server (Optional)

For programmatic access, start the HTTP server:

```bash
node memory-store.js serve --port 9100
```

Then make HTTP requests:

```bash
# Health check
curl http://127.0.0.1:9100/health

# Create a mission
curl -X POST http://127.0.0.1:9100/missions \
  -H "Content-Type: application/json" \
  -d '{"title": "Refactor auth module"}'

# Search memories
curl -X POST http://127.0.0.1:9100/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query": "database"}'

# Get code hotspots
curl http://127.0.0.1:9100/code/hotspots/my-project

# Create a todo ledger
curl -X POST http://127.0.0.1:9100/todo-ledgers \
  -H "Content-Type: application/json" \
  -d '{"missionId": "mission-1"}'

# Create a todo
curl -X POST http://127.0.0.1:9100/missions/mission-1/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Refactor auth module"}'
```

## How Auto-Detection Works

The extension automatically captures decisions, bugfixes, and discoveries from assistant messages during Pi sessions. This means many memories are saved without explicit `memory-save` calls.

Detected patterns include:
- **Design decisions**: "I'll use X", "going with", "switching to"
- **Bug fixes**: "root cause", "the bug was", "fix is"
- **Discoveries**: "I discovered", "turns out", "found that"

## Session Lifecycle

1. **Session start** — context is auto-loaded from relevant memories
2. **During session** — save decisions and discoveries as they happen
3. **Session end** — summary is auto-saved, trust recovery runs
4. **Dream Cycle** — runs at turn 50 of each session (and again at `session-end` if it did not run) to consolidate `session_summary` observations and clean stale memories. Use `node memory-store.js cleanup-sessions` for a one-shot retroactive cleanup of pre-#194 databases.

## Using LaPis with Claude Code

LaPis provides the same memory, guardrails, and session lifecycle in [Claude Code](https://code.claude.com/docs/en/overview) via MCP tools plus hooks:

```bash
npx -y @genegulanesjr/lapis claude-code install
npx -y @genegulanesjr/lapis claude-code doctor
```

This writes:

- `.mcp.json` — LaPis MCP tools (`mcp__lapis__memory-save`, `memory-code`, …)
- `.claude/settings.json` — lifecycle hooks (context injection, guardrails, passive capture)

Start `claude` in the project root. Approve the MCP server on first use (`/mcp`). Memories and indexes are stored in the same `~/.pi/memory/memory.db` database Pi uses — no separate Claude Code database.

Optional performance tier — keep a warm dispatch daemon instead of cold-starting Node per hook:

```bash
lapis claude-code install --daemon
# or manage separately:
lapis claude-code start --detached
```

Full hook mapping, install flags, troubleshooting, and deliberate Pi divergences: [`docs/CLAUDE_CODE.md`](CLAUDE_CODE.md).

## Using LaPis as an MCP server (other hosts)

For MCP clients that only need tools (no hooks), run:

```bash
npx -y @genegulanesjr/lapis mcp
```

See [`docs/MCP.md`](MCP.md) for capability comparison and host configuration.

## See Also

- [`CLAUDE_CODE.md`](CLAUDE_CODE.md) — Claude Code install and hooks
- [`MCP.md`](MCP.md) — standalone MCP server

- [`API.md`](API.md) — full HTTP API and CLI reference
- [`COMMANDS.md`](COMMANDS.md) — complete CLI command reference
- [`CONFIGURATION.md`](CONFIGURATION.md) — configuration options
- [`SKILL.md`](SKILL.md) — extension skill documentation
