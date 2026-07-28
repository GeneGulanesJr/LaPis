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
- `bash` grep/rg/find on source code in an indexed repo → BLOCKED for browsing/scanning. Use `memory-code` instead.
- Targeted exact-symbol grep/rg is allowed when it is clearly cheaper than semantic search, e.g. `grep -rn "rankObservations" src/`.
- After calling `memory-code outline` on a file, subsequent reads are allowed.
- Avoid duplicate locator steps: once exact-symbol grep or `memory-code` identifies the file, go straight to a targeted `read` with `offset`/`limit` instead of running another search.
- Always include `--repo` with `memory-code`/`memory-doc` when known. In a project session this is usually the current project name.
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
- **Auto-dreams at turn 50** — runs the Dream Cycle at turn 50 of each active session (and once more at `session-end` if it did not run) to clean stale memories (not just old). Targets superseded, zero-recall auto-saved, stale corrections, and replaced configs. Consolidates accumulated `session_summary` observations into one per project. Age alone is NOT a signal. A `cleanup-sessions` CLI command is available for one-shot retroactive cleanup of databases created before this trigger moved.

### When to use the tools

- **`memory-save`** — Decisions, bugfixes, architecture constraints, patterns, discoveries. Always search first.
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
