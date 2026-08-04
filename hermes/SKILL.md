---
name: lapis
description: "Use LaPis persistent coding memory via the 'lapis' MCP server: memory-code/doc/save/search tools, repo indexing, and retrieval protocols."
version: 1.0.0
author: LaPis
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [memory, coding, mcp, lapis, sqlite, code-index]
    related_skills: [hermes-agent]
---

# LaPis — Persistent Coding Memory

LaPis is a local coding-memory stack (SQLite at `$LAPIS_HOME/.pi/memory/memory.db` — or `~/.pi/memory/memory.db` when `LAPIS_HOME` is unset; no cloud, no API keys) wired into Hermes as an MCP server named `lapis`. It is a persistent memory layer shared across tools (Pi, Claude Code, Hermes). Use it for code intelligence, doc navigation, and durable cross-session memory.

## Tools (MCP server `lapis` → `mcp_lapis_*`)

| Tool | Purpose |
|---|---|
| `mcp_lapis_memory_save` | Save memory: `title`, `content`, `type` (decision/bugfix/architecture/pattern/discovery/config/preference/learning/manual), `scope` (project/personal), `topic_key`, `expires_in` (e.g. `7d`), `force` |
| `mcp_lapis_memory_search` | Search memories: `query`, optional `type`/`scope` filters, `limit` |
| `mcp_lapis_memory_get` / `update` / `delete` / `related` | Full CRUD by ID + symbol-linked recall |
| `mcp_lapis_memory_load_context` | Deep-dive on everything memory knows about a topic |
| `mcp_lapis_memory_code` | Code-index queries. **Modes:** `outline`, `callers`, `callees`, `blast-radius`, `dead-code`, `complexity`, `deps`, `churn`, `hotspots`, `cycles`, `importance`, `coupling`, `extractable`, `hierarchy`, `signal-chains`, `layer-violations`, `search`, `index-repo`, `reindex-repo` |
| `mcp_lapis_memory_doc` | Doc-index queries. **Modes:** `search`, `outline`, `backlinks`, `broken-links`, `glossary`, `tutorial-path`, `code-examples`, `orphans`, `coverage`, `stale-pages`, `duplicates`, `index-docs`, `reindex-docs` |
| `mcp_lapis_memory_sync_code_trust` | After git pull/checkout/merge/rebase: sync trust scores with changed code |
| `mcp_lapis_index_status` | Check progress of an async index job |

## Retrieval protocol (indexed repos)

- **Code lookups → `mcp_lapis_memory_code`, not raw file reads.** Prefer `outline` on a file before reading it whole.
- Whole-file `read_file` on indexed code files is discouraged: run `memory-code` `outline` first; targeted reads with `offset`/`limit` are allowed for editing. (A `pre_tool_call` hook enforces this when the LaPis hooks are installed.)
- Semantic code queries → `memory-code` mode `search`. Exact single-symbol lookups → targeted grep is fine.
- **Docs → `mcp_lapis_memory_doc`**, not raw browsing.
- After git operations, run `memory_sync_code_trust`.

## Memory content format

```
**What**: <what happened / decision>
**Why**: <reasoning>
**Where**: <file/symbol/repo>
**Learned**: <lesson for the future>
```

Always `memory-search` before saving to avoid duplicates. Use `memory_update` (by ID) to correct an existing memory instead of adding a correction entry.

## Indexing a repo (first time)

- Via MCP: `mcp_lapis_memory_code` with mode `index-repo` (repo = repo root path or name)
- Via CLI: `lapis index-repo --path <absolute-path>` (or `index-repo-async` + poll `index-status`)
- Verify: `lapis list-code-repos`

## Scope & pitfalls

- **Memories are project-scoped by cwd** — run/query from the repo root so items attach to the right project.
- `LAPIS_HOME` pins the memory directory (set by `lapis hermes install` in the MCP server env) so the server and CLI always share one database even when the host process has a different `HOME`.
- Nothing indexed yet → `list-code-repos` returns `{"repos": [], "total": 0}`; index before relying on guardrails.
- Verify the install any time with: `lapis hermes doctor`.
