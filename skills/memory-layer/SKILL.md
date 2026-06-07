---
name: memory-layer
description: Standalone persistent memory for Pi — smart search, symbol clustering, dedup, auto-recovery, trust scoring. Zero Python dependency.
---

# Pi Memory Layer v6.2

Persistent memory via a single SQLite database (`~/.pi/memory/memory.db`).
All operations through `memory-store.js` — zero Python dependency, zero MCP servers.
Code parsing uses web-tree-sitter (WASM) in-process.
Code analysis (imports, call graph, complexity, dead code, churn) and doc indexing (markdown sections, links, glossary, code examples) built in — no external tools needed.
Optional HTTP server for programmatic access to the Aurex domain (missions, milestones, working units) and code analysis endpoints.

## CLI Quick Reference

### Session lifecycle

- `session-start --project NAME` → auto-recovers incomplete sessions, returns `{ sessionId, recoveredSession }`
- `session-end --id INT --memories INT [--auto]` → trust-recovery + close

### LaPis install/update

- Install: `pi install git:github.com/GeneGulanesJr/LaPis`
- Update: `pi update --extensions` or `pi update --extension git:github.com/GeneGulanesJr/LaPis`
- Restart/reload Pi after updating so the refreshed prompt and extension resources are loaded

### Observations

- `save --title TEXT --content TEXT [--type TYPE] [--project NAME] [--scope project|personal] [--topic-key KEY] [--session-id ID] [--force]`
  - Dedup pipeline: trigram overlap checked against existing observations of the same type+project.
  - **≥85% overlap** → auto-merges (keeps new, soft-deletes old, records `observation_relations`).
  - **60-84% overlap** → `potential_duplicate` warning, lists matching IDs.
  - Use `--force` to bypass dedup entirely.
- `update --id INT [--title TEXT] [--content TEXT] [--type TYPE] [--scope SCOPE] [--topic-key KEY]`
  - Update an existing observation in-place by ID. Only provided fields are changed.
  - Use instead of saving a correction entry to avoid duplicate/misleading memories.
- `delete --id INT`
  - Soft-delete an observation by ID. The memory is marked deleted but can be recovered.
  - Use to clean up stale, incorrect, or superseded memories.
- `search --query TEXT [--project NAME] [--type TYPE] [--scope SCOPE] [--limit N] [--session-id ID]`
  - Hybrid ranking: FTS5 relevance × recency × trust × recall history.
  - **Recall auto-logged** when `--session-id` is provided.
  - Results include `_score` for transparency.
  - `--include-code` flag returns both memories AND indexed code symbols.
- `get --id ID` — Read full memory details. In the Pi tool, `memory-get` rejects project-scoped memories from another project unless `allow_cross_project=true` is set, to avoid accidentally pulling stale or unrelated context.
- `context --project NAME [--limit N] [--session-id ID] [--topic-key KEY] [--query TEXT] [--deep true]`
  - Priority-weighted: decisions/architecture first, then bugfixes/patterns, then discoveries.
  - Includes cross-project personal-scope observations.
  - Excludes `skill` type from project context.

### Code Indexing (v3 — tree-sitter AST parser, WASM)

- `index-repo --path ABS_PATH [--name NAME]` — Index a local folder with tree-sitter.
- `reindex-repo --repo NAME [--mode full|incremental]` — Incremental reindex via mtime.
- `search-code --query TEXT [--repo NAME] [--kind TYPE] [--max-results N]` — FTS5 BM25 over code symbols.
- `ranked-code-context --query TEXT [--repo NAME] [--token-budget N] [--max-results N]` — Token-budgeted ranked code context for injection.
- `get-code-source --repo NAME --file PATH --name SYMBOL` — Byte-accurate source retrieval.
- `list-code-repos` / `remove-code-repo --repo NAME` — Manage indexed repos.

**Fast-path guidance:** For exact current-code questions, use one locator step, then a targeted read. If you already know the symbol name, exact `grep`/`rg` is acceptable when it is clearly cheaper than semantic search. If using `memory-code`, include `--repo` when known. After a locator identifies the file, do not run another broad search; call `outline --repo NAME --file F` only if structure is needed, then use `read` with `offset`/`limit`.

**Supported:** JavaScript, TypeScript, TSX, Go, Python, Rust, SQL. Uses web-tree-sitter (WASM) — zero Python dependency.
Grammar .wasm files bundled in `grammars/`.

### Code Analysis (v5 — import graph, call graph, complexity, dead code)

- `import-graph --repo NAME [--file F] [--direction imports|importers|both] [--depth N]` — Import dependency graph with recursive traversal
- `call-hierarchy --symbol S --repo NAME [--direction callers|callees] [--depth N]` — Call graph hierarchy
- `blast-radius --symbol S --repo NAME [--depth N]` — What breaks if a symbol changes
- `dead-code --repo NAME [--min-confidence 0.5] [--include-tests true]` — Find unused code
- `complexity --repo NAME [--symbol S]` — Cyclomatic complexity per function
- `outline --repo NAME --file F` — File symbol outline (classes, methods, standalone)
- `churn --repo NAME [--file F] [--days 90] [--refresh true]` — Git commit frequency metrics

### Code Analytics (v5.2 — hotspots, cycles, importance, coupling, extraction, hierarchy)

- `hotspots --repo NAME [--top N] [--days N]` — Top N symbols by complexity × churn (bug risk)
- `cycles --repo NAME` — Dependency cycles via Tarjan SCC on import graph
- `importance --repo NAME [--top N] [--scope DIR]` — Symbol PageRank on call graph
- `coupling --repo NAME [--file F] [--sort-by instability|afferent|efferent]` — Afferent/efferent/instability per file
- `extractable --repo NAME [--min-complexity N] [--min-callers N] [--top N]` — Refactoring candidates (complex functions called from many files)
- `hierarchy --repo NAME --symbol S [--direction both|ancestors|descendants]` — Class hierarchy from parent_name

### Code Analytics (v5.3 — signal chains, layer violations, AST calls)

- `signal-chains --repo NAME [--kind http|cli] [--symbol S] [--max-depth N]` — Detect HTTP/CLI gateways and trace call chains
- `layer-violations --repo NAME [--rules JSON]` — Check import rules against declared architecture layers

### Code Analytics (v5.4 — winnow, AST patterns, provenance, untested, PR risk)

- `winnow --repo NAME` — Filter analysis results by confidence/type
- `ast-patterns --repo NAME` — AST-based code smell and pattern detection
- `provenance --repo NAME` — Git blame-based provenance for symbols
- `untested --repo NAME` — Find symbols without test coverage
- `pr-risk --repo NAME` — Assess risk of changes for PR review
- `coding-context --repo NAME [--symbol S | --file F]` — Unified before-edit context for coding tasks. Ambiguous symbols are auto-disambiguated (prefers function/method/class kinds, uses file hint when both `--symbol` and `--file` are provided).

**Note:** Layer rules can be defined inline via `--rules` or in a `.pimemory-layers.jsonc` file at the repo root.
Signal chains detect Express routes (`app.get/post/...`), router patterns, and CLI commands.
AST call resolution (v5.3) uses tree-sitter `call_expression` nodes instead of regex for JS/TS.

**Note:** Churn metrics require `git` CLI. All other analysis works on any indexed repo.
Complexity does NOT count `?.` optional chaining as a decision point.
Dead code confidence: 0.33 per signal (no callers, unreachable file), 1.0 = provably unreachable.

### Doc Indexing (v5 — markdown sections, links, glossary, code examples)

- `index-docs --path P --name NAME [--ignore GLOB]` — Index a markdown doc tree
- `reindex-docs --repo NAME [--mode full] [--ignore GLOB]` — Re-index a doc repo
- `doc-search --query Q --repo NAME [--level N] [--role TYPE]` — Full-text search across doc sections
- `doc-outline --repo NAME [--file F]` — Section hierarchy outline
- `backlinks --repo NAME --path F` — Find all docs that link TO a given doc
- `broken-links --repo NAME` — Find broken internal doc links
- `glossary --repo NAME [--term T]` — Look up glossary terms (`**Term** — definition` pattern)
- `tutorial-path --section INT --repo NAME` — Reconstruct ordered tutorial chain
- `code-examples --query Q --repo NAME [--lang X]` — Search fenced code blocks by content
- `doc-orphans --repo NAME [--include-same-doc]` — Find sections with zero inbound links
- `doc-coverage --repo NAME [--doc-repo DOC_REPO]` — Which code symbols have documentation coverage

### Doc Analytics (v5.3 — stale pages, duplicates)

- `stale-pages --repo NAME` — Find docs modified since last index (mtime comparison)
- `doc-duplicates --repo NAME` — Find duplicate sections by content hash

**Hashtag extraction:** `(?<!#)#(\w{2,})` with negative lookbehind (excludes ATX headings).
**Heading slugs:** lowercase → strip non-alphanumeric → replace spaces with hyphens (GitHub-compatible).
**Role classification:** tutorial, api, how_to, concept, troubleshooting, changelog, faq, example, other.

### Workspace Management (v4)

- `list-workspaces` — All workspaces with counts and archive status.
- `create-workspace --name NAME` — Create a named workspace.
- `archive-workspace --name NAME` — Soft-archive (data preserved).

### Symbol-aware recall

- `symbol-cluster --symbol SYMBOL_ID [--repo NAME]` — all memories for a symbol
- `related --id INT` — memories linked to the same symbols
- `link-symbol --memory TEXT --symbol TEXT --repo TEXT [--trust REAL]`
- `auto-link --project NAME`
- `sync-code-trust --repo TEXT` — trust sync after git changes (compares stored HEAD vs current HEAD via built-in index)

### Maintenance

- `compact` — prune dead links, decay stale trust, VACUUM, optimize FTS5 (auto-runs every 5 sessions)
- `dream` — Dream Cycle: clean **stale** (not just old) memories:
  1. **Superseded** — memories replaced by newer ones (via `observation_relations`)
  2. **Stale auto-progress** — progress checkpoints & edit tracking with zero recall
  3. **Never-recalled auto-detected** — auto-saved decisions/bugfixes never useful + low trust
  4. **Stale corrections** — "CORRECTION:" titles (should've used `update`)
  5. **Replaced configs** — superseded configs (e.g. "using frpc" → "switched to CF Tunnel")

  Age alone is NOT a signal. A 6-month-old valid decision stays. A 1-day-old superseded one goes.
  Auto-runs every 10th session. Run manually: `memory-store.js dream` or `/memory-dream`.

- `stats`
- `list-projects`
- `init` — Initialize the database schema.

## HTTP Server

LaPis includes an optional HTTP server for programmatic access to the Aurex domain model and code analysis features:

```bash
node memory-store.js serve [--host HOST] [--port PORT]
```

Defaults to `127.0.0.1:9100`. Provides REST endpoints for missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings, sessions, memory search, costs, retry/rescope, compression, checkpoints, settings, and code indexing/analysis. See [`docs/API.md`](docs/API.md) for the full endpoint reference.

## Project Detection (v3.2)

On session start, the extension:

1. Queries `list-projects` for all known project names
2. Walks up the current working directory tree
3. Returns the first directory name matching a known project
4. Falls back to `path.basename(cwd)` if nothing matches

### Cross-Project Fallback

When a project has zero memories, loads cross-project context from all known projects.
Personal preferences always load regardless of project.

## Session Protocol

### Start

1. `session-start --project <PROJECT>` → save `sessionId`
2. Incorporate context from returned `observations` and `personal` lists
3. If `recoveredSession` is present, review what was auto-recovered

### During Session

- Save immediately: decisions, preferences, bugfixes, architecture constraints
- Save if novel: new dependencies, file discoveries, repeated patterns
- Search before saving to avoid duplicates
- Use `--scope personal` for preferences that apply across all projects

### End

1. `session-summary --content "## Goal\n...\n## Accomplished\n..."`
2. `session-end --id <ID> --memories <COUNT> --auto`

## Search Ranking

- **FTS5 relevance** (40%) — text match quality
- **Recency** (30%) — exponential decay, 7-day half-life
- **Trust score** (15%) — from symbol links
- **Recall history** (15%) — how often this memory was useful
- **Type boost** — decisions/architecture ranked higher than summaries

## Dedup Policy

On `save`, trigram overlap checked against existing observations:

- **≥85% overlap** → auto-merge
- **60-84% overlap** → potential_duplicate warning
- Use `--force` to bypass

## Trust Scoring

| Trust Range | Behavior                    |
| ----------- | --------------------------- |
| 0.8 - 1.0   | Surface confidently         |
| 0.5 - 0.7   | Surface with caveat         |
| 0.3 - 0.4   | Surface with warning        |
| 0.0 - 0.2   | Don't surface automatically |

## Graceful Degradation

- No web-tree-sitter → code indexing disabled gracefully, non-code features work
- No git → churn metrics disabled, all other features work
- No sqlite3 → fails with install instructions
- DB corrupted → suggest deleting `~/.pi/memory/memory.db`
- No MCP server needed — fully self-contained (v5 includes code analysis + doc indexing natively)

### Cache Invalidation (v6.2)

- `index-repo` and `reindex-repo` invalidate the repo cache immediately, so guardrails recognize the repo on the very next tool call.
- `isRepoStale` now samples up to 50 source file mtimes (not directory mtime) to accurately detect stale indexes.
- Config files (package.json, tsconfig.json, etc.) are excluded from guardrail blocking.

## Reliability Layer (v6.2 — extension hooks)

The extension proactively ensures memory is always invoked at the right moment.
All hooks are non-blocking — they enhance, not replace, explicit tool usage.

| Hook               | Situation                                                     | Response                                                                                                                             |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `session_compact`  | User runs `/compact` or auto-compaction fires                 | Re-inject full memory context (observations + preferences + status) so LLM retains awareness                                         |
| `context`          | 5+ consecutive non-memory LLM calls                           | Sliding-window reminder to use memory-search/memory-save (resets on any memory tool use)                                             |
| `message_end`      | Assistant message with decision/bugfix/discovery pattern      | Auto-save as observation with detected type (dedup pipeline active)                                                                  |
| `turn_end`         | Every 10th turn                                               | Progress checkpoint with files touched + memory count                                                                                |
| `tool_call`        | LLM reads code files directly (indexed repo, no offset/limit) | **Hard block** — forces `memory-code outline` first; **excludes config files** (package.json, tsconfig, etc.); partial reads allowed |
| `tool_call`        | LLM uses grep/rg/find on source code in indexed repo          | **Hard block** for browsing/scanning — forces `memory-code` instead; targeted exact-symbol grep/rg is allowed when cheaper           |
| `tool_call`        | LLM calls memory-code with file param                         | Marks file as explored → future reads allowed                                                                                        |
| `tool_call`        | LLM calls memory-code with any mode                           | Track result files as explored via `tool_result`; reset callsSinceLastMemory counter                                                 |
| `tool_call`        | LLM uses memory-\* tools                                      | Track last-usage timestamp + reset sliding window counter                                                                            |
| `tool_result`      | memory-code returns results with file paths                   | Extract file paths from results → add to `exploredFiles`                                                                             |
| `tool_result`      | bash with git pull/checkout/merge                             | Auto-sync code trust scores                                                                                                          |
| `tool_result`      | edit/write on code files                                      | Track file for session summary + periodic auto-save                                                                                  |
| `session_shutdown` | Session ends                                                  | Rich summary with topics discussed + files modified + turn count                                                                     |

### Decision Detection Patterns

The extension pattern-matches assistant messages for:

- **Design decisions**: "I'll use X", "going with", "switching to", "using X instead of Y"
- **Architecture choices**: "approach:", "strategy:", "architecture:", "pattern:"
- **Bug fixes**: "root cause", "the bug was", "fix is", "workaround is"
- **Discoveries**: "I discovered", "turns out", "found that"
- **Constraints**: "we need to", "cannot", "constraint", "requirement"

Cooldown of 60s between auto-saved decisions prevents noise.
Auto-saved decisions are explicitly marked with `**What**: Auto-detected ...` format.
Dedup pipeline is active for auto-detected decisions (no `force` bypass) — prevents duplicate noise from repeated patterns.
