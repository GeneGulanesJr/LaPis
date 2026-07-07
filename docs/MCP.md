# MCP Server

LaPis exposes a **Model Context Protocol (MCP)** stdio server as a second transport alongside the Pi extension. MCP clients get the **tool surface** (`memory-save`, `memory-search`, `memory-code`, `memory-doc`, and related commands) without Pi's in-process hooks, session lifecycle, or guardrails.

Claude Code users should prefer the [first-class hooks integration](CLAUDE_CODE.md) (`lapis claude-code install`), which wires MCP tools **and** lifecycle hooks for parity with Pi. Standalone MCP is for other MCP hosts (Cursor, custom agents, etc.) that only need tools.

## Quick start

From a project directory:

```bash
npx -y @genegulanesjr/lapis mcp
```

Or via the `lapis-mcp` bin alias:

```bash
lapis-mcp
```

The server speaks MCP over **stdio**. Configure your MCP host to spawn the command above (see each host's MCP config format).

### Claude Code project config

For Claude Code without hooks (tools only), add to `.mcp.json`:

```json
{
  "mcpServers": {
    "lapis": {
      "command": "npx",
      "args": ["-y", "@genegulanesjr/lapis", "mcp"]
    }
  }
}
```

`lapis claude-code install` writes this entry automatically and adds the hooks config in `.claude/settings.json`.

## What MCP provides vs Pi / Claude Code hooks

| Capability | Pi extension | MCP only | Claude Code (MCP + hooks) |
| --- | --- | --- | --- |
| Memory tools (`memory-*`) | Yes | Yes | Yes |
| Code/doc tools | Yes | Yes | Yes |
| Session start context injection | Yes | No | Yes (hooks) |
| Read/search guardrails | Yes | No | Yes (hooks) |
| Passive capture / Dream Cycle | Yes | No | Yes (hooks) |
| Git trust sync | Yes | No | Yes (hooks) |
| Tool-state / turn tracking | In-process | No | Disk-backed + mirroring |

## Project detection

The MCP server derives the active project key from the client's working directory:

1. **Indexed repo path prefix** — if `cwd` is inside an indexed repo (including monorepo subdirs like `packages/foo`), that repo's name is used.
2. **Known memory projects** — basename walk over parent directories against `list-projects` names.
3. **Basename fallback** — lowercased directory basename (same heuristic as early MCP builds).

This uses the shared [`hooks-engine/project`](MODULE_MAP.md) helpers and [`platform/project-db`](MODULE_MAP.md) cache — the same resolution path as the Claude Code bridge.

Set `CLAUDE_PROJECT_DIR` when the MCP host runs LaPis from a different cwd than the project root (Claude Code sets this automatically).

## Tool catalog

Tools are defined in `src/mcp/tools.js` and map to `gateway.dispatch()` commands. Names exposed to MCP hosts:

- **Memory**: `memory-save`, `memory-update`, `memory-delete`, `memory-get`, `memory-search`, `memory-related`, `memory-load-context`, `memory-sync-code-trust`
- **Code**: `memory-code` (modes: search, outline, callers, callees, …)
- **Docs**: `memory-doc` (modes: search, outline, backlinks, …)

Full tool schemas are returned by the MCP `list_tools` request at runtime.

## Implementation boundary

```
MCP host
  -> lapis mcp (stdio)
  -> src/mcp/server.js          # transport adapter only
  -> src/cli/gateway.js         # command dispatch
  -> src/{feature}/             # business logic
```

`src/mcp/server.js` owns framing, tool listing, and result translation (`translate-result.js`). It does **not** contain feature logic, SQL, or hook behavior. See [`MODULE_MAP.md`](MODULE_MAP.md).

## npm export

```js
// Programmatic server construction (tests, custom hosts)
const { createServer } = require('@genegulanesjr/lapis/mcp'); // if exported — otherwise require('./src/mcp/server')
```

The published package exposes MCP via the `lapis mcp` / `lapis-mcp` CLI entry point (`memory-store.js` → `cli.js`).

## Shared storage

MCP uses the same SQLite database as Pi and Claude Code hooks:

```text
~/.pi/memory/memory.db          # configurable via ~/.pi/memory/config.jsonc
```

There is no separate MCP database. Memories, indexes, and trust scores written through MCP are visible to Pi and Claude Code in the same project.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tools return DB errors | Run `node memory-store.js init` or `lapis claude-code doctor` |
| Wrong project key | Index the repo (`index-repo`) or set `CLAUDE_PROJECT_DIR` |
| `better-sqlite3` load failure | Run `npm install` in a local clone or use `npx` for a matching published binary |
| Need guardrails + lifecycle | Use [`lapis claude-code install`](CLAUDE_CODE.md), not MCP alone |

## See also

- [`CLAUDE_CODE.md`](CLAUDE_CODE.md) — full Claude Code integration (recommended for Claude Code users)
- [`COMMANDS.md`](COMMANDS.md) — underlying CLI commands tools call
- [`CONFIGURATION.md`](CONFIGURATION.md) — database and ranking config
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — transport and module overview
