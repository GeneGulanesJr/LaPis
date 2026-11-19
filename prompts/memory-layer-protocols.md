# Protocols

## 1. Code & Doc Retrieval — memory-code / memory-doc

LaPis is the canonical Pi memory stack. Its code/doc indexes answer structural questions that plain search cannot:

- **Code** → `memory-code` tool
  - Modes: search, callers, callees, blast-radius, dead-code, complexity, deps, outline, churn, hotspots, cycles, importance, coupling, extractable, hierarchy, signal-chains, layer-violations, coding-context, preflight, agent-pack, health, index-repo, reindex-repo, dupes, audit-diff, enrich-symbols
- **Docs** → `memory-doc` tool
  - Modes: search, outline, backlinks, broken-links, glossary, tutorial-path, code-examples, orphans, coverage, stale-pages, duplicates, index-docs, reindex-docs

If a repo isn't indexed yet, the tool will tell you exactly how to index it.

**When to reach for which tool:**

- Use native read / grep / find freely — they are the default for reading and exact-name searches.
- Reach for `memory-code` when it answers what grep cannot: `callers`, `callees`, `blast-radius`, `deps`, `cycles`, `hotspots`, or a semantic `search` ("how does context injection work"). Use `memory-doc` the same way for docs.
- Include `--repo` with `memory-code`/`memory-doc` when known.
- Optional enforcement: `tool_guardrails.enabled: true` (or `LAPIS_GUARDRAILS=1`) blocks whole-file reads of indexed code and broad grep/find scans. Off by default.

## 2. Persistent Memory — Automatic

Memory is handled automatically by the `memory-layer` extension. It:

- **Injects context** at session start (decisions, preferences, recent memories)
- **Re-injects context after compaction** — `/compact` no longer destroys memory awareness
- **Auto-detects decisions** — pattern-matches assistant messages for decisions, bugfixes, discoveries, and auto-saves them
- **Periodic progress checkpoints** — every 10 turns, saves an auto-checkpoint with files edited
- **Git-triggered trust sync** — after git pull/checkout/merge/rebase, auto-syncs code trust scores
- **Auto-saves session summaries** on shutdown with topics, files, and turn count
- **Auto-recovers** incomplete sessions
- **Detects stale indexes** and warns when code indexes are out of date
- **Auto-dreams at turn 50** — runs the Dream Cycle once per session, at turn 50 of each active session, to clean stale memories (not just old). Targets superseded, zero-recall auto-saved, stale corrections, and replaced configs. Consolidates accumulated `session_summary` observations into one per project. Age alone is NOT a signal. A `cleanup-sessions` CLI command is available for one-shot retroactive cleanup of databases created before this trigger moved.

### When to use the tools

- **`memory-save`** — Decisions, bugfixes, architecture constraints, patterns, discoveries. It checks for duplicates itself.
- **`memory-update`** — Correct or refine an existing memory in-place by ID. Use instead of saving a correction entry.
- **`memory-delete`** — Remove stale, incorrect, or duplicate memories by ID (soft-delete, recoverable).
- **`memory-search`** — Before making decisions, to avoid repeating past mistakes or re-deciding settled questions.
- **`memory-get`** — To read the full content of a specific memory returned by `memory-search`; do not fetch arbitrary IDs from stale or unrelated context before searching the current project.
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

## Startup invariant

When LaPis is installed and loaded, assume these behaviors are always active:

- code/doc retrieval should use LaPis tools first
- raw source reads/searches should be treated as a fallback to be avoided
- trust-sync should be automatic after git changes

## LaPis Quick Start

- Install: `pi install git:github.com/GeneGulanesJr/LaPis`
- Update: `pi update --extensions` or `pi update --extension git:github.com/GeneGulanesJr/LaPis`
- Source of truth: the packaged `prompts/`, `skills/`, and `extensions/` in the LaPis repo
- If the package is updated, restart/reload Pi so the new prompt and extension resources are reloaded
