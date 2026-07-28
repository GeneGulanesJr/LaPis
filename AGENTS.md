# Protocols

## 1. Code & Doc Retrieval — Use memory-code / memory-doc

LaPis is the canonical Pi memory stack. For any code/doc lookup, prefer LaPis tools first.

The `memory-layer` extension **enforces** structured retrieval over raw file reads:

- **Code** → `memory-code` tool
  - Modes: callers, callees, blast-radius, dead-code, complexity, deps, outline, churn, hotspots, cycles, importance, coupling, extractable, hierarchy, signal-chains, layer-violations, index-repo, reindex-repo
- **Docs** → `memory-doc` tool
  - Modes: search, outline, backlinks, broken-links, glossary, tutorial-path, code-examples, orphans, coverage, stale-pages, duplicates, index-docs, reindex-docs

If a repo isn't indexed yet, the tool will tell you exactly how to index it.

**Enforcement rules:**

- `read` on a code file in an indexed repo **without** offset/limit → BLOCKED. Use `memory-code outline` first.
- `read` on a code file **with** offset/limit → ALLOWED (editing targeted lines).
- `bash grep/rg` for **browsing or scanning** source code in an indexed repo → BLOCKED. Use `memory-code` instead.
- `bash grep/rg` for **targeted single-symbol lookup** (e.g., `grep -rn "rankObservations" src/`) → ALLOWED when faster than memory-code for exact-name searches.
- `bash find` for file discovery in an indexed repo → BLOCKED. Use `memory-code search` instead.
- After calling `memory-code outline` on a file, subsequent reads are allowed.
- Prefer `memory-code search` for **semantic** queries (e.g., "how does context injection work"). Prefer `bash grep` for **exact symbol** queries (e.g., "where is rankObservations defined").
- If a lookup seems to need raw source browsing, stop and use `memory-code` / `memory-doc` instead.

## 2. Persistent Memory — Automatic

Memory is handled automatically by the `memory-layer` extension. It:

- **Injects context** at session start (decisions, preferences, recent memories)
- **Re-injects context after compaction** — `/compact` no longer destroys memory awareness
- **Auto-detects decisions** — pattern-matches assistant messages for decisions, bugfixes, discoveries, and auto-saves them
- **Periodic progress checkpoints** — every 10 turns, saves an auto-checkpoint with files edited
- **Persistent memory reminder** — every 5th LLM call, injects a lightweight reminder if no memory tool was used recently
- **Git-triggered trust sync** — after git pull/checkout/merge/rebase, auto-syncs code trust scores
- **Auto-saves session summaries** on shutdown with topics, files, and turn count
- **Auto-recovers** incomplete sessions
- **Detects stale indexes** and warns when code indexes are out of date
- **Hard-blocks reads of code files** in indexed repos — must use `memory-code outline` first; partial reads (offset/limit) allowed for editing
- **Auto-dreams at turn 50 of each active session** — runs the Dream Cycle to clean stale memories (not just old). Targets superseded, zero-recall auto-saved, stale corrections, and replaced configs. Age alone is NOT a signal.

### When to use the tools

- **`memory-save`** — Decisions, bugfixes, architecture constraints, patterns, discoveries. Always search first.
- **`memory-update`** — Correct or refine an existing memory in-place by ID. Use instead of saving a correction entry.
- **`memory-delete`** — Remove stale, incorrect, or duplicate memories by ID (soft-delete, recoverable).
- **`memory-search`** — Before making decisions, to avoid repeating past mistakes or re-deciding settled questions.
- **`memory-get`** — To read the full content of a specific memory.
- **`memory-related`** — To find all memories linked to the same code symbol.
- **`memory-load-context`** — Deep-dive into everything memory knows about a specific topic.
- **`memory-sync-code-trust`** — After git pulls / branch switches, to sync trust scores with changed symbols. Compares stored HEAD vs current HEAD automatically using the built-in code index.

### Content format

Use **What/Why/Where/Learned** in the content field:

```
**What**: …
**Why**: …
**Where**: …
**Learned**: …
```

### No manual protocol needed

The extension handles session start, context loading, and session shutdown automatically. No bash calls to memory-store.js needed during sessions.

Full feature docs: `~/.pi/agent/skills/memory-layer/SKILL.md`

## 3. Important: Two Different "Cache" Systems

Pi's footer shows `cache` usage — but this is **NOT** the persistent memory layer. There are two separate systems:

### API Prompt Cache (what the footer shows)

- Controlled by: `PI_CACHE_RETENTION` environment variable
- Purpose: LLM provider's own token reuse to **save cost**
- Scope: **Per-session, time-limited** (Anthropic: 5min default / 1h with `long`; OpenAI: in-memory / 24h with `long`)
- The `cache` number in the footer = tokens served from this short-lived cache
- This is purely an API-level optimization you generally don't need to think about

### Memory Layer (persistent across all sessions)

- Stored in: `~/.pi/memory/memory.db` (SQLite)
- Purpose: **Permanent knowledge** — stores decisions, code index, docs across all your projects forever
- Scope: **All sessions, all time** (only cleaned by Dream Cycle if stale/superseded)
- Accessed via: `/memory-search`, auto-saved decisions, symbol links
- **This is the "real" cache** — your persistent assistant memory

**Why the confusion?** The `PI_CACHE_RENTENTION` name suggests it controls Pi's memory retention, but it only controls the LLM API's prompt cache (a cost-saving feature). The memory layer has no retention setting — it's permanent by design.

> **Bottom line:** The `cache` stat in the footer is transient API optimization. The memory layer (`memory-*` tools) is your permanent knowledge base that grows across sessions.

## 4. Claude Code CLI — Same rules, different transport

When working in [Claude Code](https://code.claude.com/docs/en/overview) with LaPis installed (`lapis claude-code install`), the same retrieval and memory protocols apply. Tools arrive as `mcp__lapis__*` (or `mcp__<custom-name>__*` if renamed at install). Hooks enforce the guardrails Pi applies in-process:

- **Code** → `mcp__lapis__memory-code` (same modes as Pi's `memory-code`)
- **Docs** → `mcp__lapis__memory-doc`
- **Memory** → `mcp__lapis__memory-save`, `memory-search`, `memory-get`, etc.

Guardrails run via Claude Code `PreToolUse` hooks (not MCP): whole-file `Read` blocks, `Grep`/`Glob` search redirects, and secondary `Bash` search detection. Prefer native `Grep`/`Glob` over bash `grep`/`find` in indexed repos.

Claude Code spawns a **fresh process per hook**, so session state (`turnCount`, `editedFiles`, recall feedback) lives on disk at `~/.pi/memory/claude-sessions/`, not in-process. The SQLite database at `~/.pi/memory/memory.db` is **shared** with Pi — same memories and indexes.

Full setup: [`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md). Verify with `lapis claude-code doctor`.
