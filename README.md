# LaPis 💎

> 🇵🇭 *lapis* — pencil, to write
> 🪨 *lapis* — stone, precious gem
> 🧠 La**Pi**s — memory for Pi

Persistent memory for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). One SQLite database, zero cloud dependencies, zero API keys.

## Architecture

![PiMemory Architecture](memory-layer-architecture.png)

## One-command install

```bash
pi install git:github.com/GeneGulanesJr/LaPis
```

Restart Pi and memory auto-wires on session start. Use `pi update --extensions` to keep it up to date.

## What it does

- **Remembers across sessions** — decisions, bugfixes, patterns, discoveries persist
- **Auto-injects context** — next session starts with relevant memories loaded
- **Code indexing** — web-tree-sitter (WASM) AST parses JS/TS/Go/Python/Rust/SQL files, searchable by issue description
- **Trust scoring** — memories linked to changed code lose trust; stable code boosts it
- **Deduplication** — trigram overlap prevents duplicate saves (≥85% auto-merges, 60–84% warns)
- **Workspaces** — formal project isolation with create/list/archive
- **Session lifecycle** — auto-recovery of incomplete sessions, trust recovery on close
- **Zero servers** — single Node.js CLI + SQLite, called on demand by Pi. Zero Python dependency.
- **Dream Cycle** — every 10 sessions, cleans superseded, zero-recall, stale corrections, and replaced configs
- **Update & delete** — update memories in-place instead of spawning correction entries

## Commands (called by Pi automatically)

### Observations & Search

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `save`                                 | Save an observation (decision, bugfix, pattern, etc.) |
| `update --id`                          | Update an existing observation in-place by ID          |
| `delete --id`                          | Soft-delete an observation by ID (recoverable)        |
| `search`                               | FTS5 full-text search with hybrid ranking             |
| `search --include-code`                | Search both memories AND indexed code symbols         |
| `context`                               | Load session context by project                       |
| `get`                                  | Retrieve a single observation by ID                   |

### Code Indexing (v3 — WASM tree-sitter)

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `index-repo --path`                    | Index a local folder with tree-sitter                 |
| `reindex-repo --repo`                  | Incremental reindex via mtime                         |
| `search-code --query`                  | FTS5 BM25 search over code symbols                   |
| `get-code-source --repo --file --name` | Byte-accurate source retrieval                       |
| `list-code-repos`                      | List indexed code repos                               |
| `remove-code-repo --repo`              | Remove an indexed code repo                           |

### Code Analysis (v5 — import graph, call graph, complexity, dead code)

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `import-graph --repo`                  | Import dependency graph with recursive traversal      |
| `call-hierarchy --symbol --repo`       | Call graph hierarchy (callers/callees)                |
| `blast-radius --symbol --repo`         | What breaks if a symbol changes                       |
| `dead-code --repo`                     | Find unused code                                      |
| `complexity --repo`                    | Cyclomatic complexity per function                    |
| `outline --repo --file`                | File symbol outline (classes, methods, standalone)    |
| `churn --repo`                         | Git commit frequency metrics                          |

### Code Analytics (v5.2–v5.3 — hotspots, cycles, importance, coupling, signal chains)

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `hotspots --repo`                      | Top symbols by complexity × churn (bug risk)          |
| `cycles --repo`                        | Dependency cycles via Tarjan SCC                      |
| `importance --repo`                    | Symbol PageRank on call graph                         |
| `coupling --repo`                      | Afferent/efferent/instability per file                 |
| `extractable --repo`                   | Refactoring candidates                                 |
| `hierarchy --symbol --repo`            | Class hierarchy from parent_name                       |
| `signal-chains --repo`                 | Detect HTTP/CLI gateways and trace call chains         |
| `layer-violations --repo`              | Check import rules against declared architecture layers |

### Doc Indexing (v5 — markdown sections, links, glossary, code examples)

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `index-docs --path --name`             | Index a markdown doc tree                              |
| `reindex-docs --repo`                 | Re-index a doc repo                                    |
| `doc-search --query --repo`            | Full-text search across doc sections                   |
| `doc-outline --repo --file`            | Section hierarchy outline                              |
| `backlinks --repo --path`              | Find all docs that link TO a given doc                 |
| `broken-links --repo`                  | Find broken internal doc links                         |
| `glossary --repo --term`               | Look up glossary terms                                 |
| `tutorial-path --section --repo`       | Reconstruct ordered tutorial chain                    |
| `code-examples --query --repo`         | Search fenced code blocks by content                   |
| `doc-orphans --repo`                   | Find sections with zero inbound links                  |
| `doc-coverage --repo`                  | Which code symbols have documentation coverage         |
| `stale-pages --repo`                  | Find docs modified since last index                     |
| `doc-duplicates --repo`                | Find duplicate sections by content hash                |

### Workspace Management

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `list-workspaces`                      | List all workspaces                                   |
| `create-workspace --name`              | Create a workspace                                    |
| `archive-workspace --name`             | Archive a workspace (soft, data preserved)            |

### Maintenance

| Command                                | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `compact`                              | Prune dead links, decay trust, VACUUM, optimize FTS5  |
| `dream`                                | Dream Cycle — clean **stale** memories (not just old). Auto-runs every 10 sessions |
| `stats`                                | Database statistics                                    |
| `list-projects`                        | List all known project names                           |

#### Dream Cycle

Unlike `compact` (housekeeping: vacuum, FTS optimize), the Dream Cycle targets **staleness** — information that is no longer accurate or useful:

| Phase | What it cleans | Why it's stale |
| ----- | -------------- | ----------------- |
| Superseded | Memories with `duplicate`/`supersedes` relations | A newer memory replaces it |
| Stale auto-progress | `progress` & `accomplished` types with zero recall | Never useful, just noise |
| Stale auto-detected | Auto-detected decisions with zero recall + low trust | Pattern-matched junk never acted on |
| Stale corrections | Titles starting with "CORRECTION:" | Should've used `update` instead |
| Replaced configs | Superseded configs (e.g. "using frpc" → "switched to CF Tunnel") | Superseded setup info |

**Age alone is NOT a signal.** A 6-month-old valid decision stays. A 1-day-old superseded one goes.

## Configuration

Create `~/.pi/memory/config.jsonc` to override defaults. The file supports JSONC (JSON with `//` and `/* */` comments).

```jsonc
{
  // Database file path (default: ~/.pi/memory/memory.db)
  "db_path": "~/.pi/memory/memory.db",

  // SQLite WAL autocheckpoint threshold (default: 1000)
  "wal_autocheckpoint": 1000,

  // SQLite busy timeout in milliseconds (default: 5000)
  "busy_timeout_ms": 5000,

  // Search ranking weights (must sum to 1.0)
  "ranking": {
    "fts_relevance": 0.4,
    "recency": 0.3,
    "trust": 0.15,
    "recall": 0.15
  },

  // Deduplication thresholds (0.0 - 1.0)
  "dedup": {
    // Auto-merge duplicates at or above this similarity
    "auto_merge_threshold": 0.85,
    // Flag potential duplicates at or above this similarity
    "warning_threshold": 0.60
  },

  // Run compaction every N sessions for a project (default: 5)
  "compact_every_n_sessions": 5,

  // Path to tier config file (default: ~/.pi/memory/tier.jsonc)
  "tier_config_path": "~/.pi/memory/tier.jsonc"
}
```

All options are optional — only include the ones you want to change. Missing values use built-in defaults.

## Requirements

- **Node.js ≥ 22.5** (built-in `node:sqlite`) or Node.js with `better-sqlite3`
- No Python dependency — code parsing uses web-tree-sitter (WASM) in-process
- No API keys or cloud services needed

## Supported Languages for Code Indexing

JavaScript, TypeScript, TSX, Go, Python, Rust, SQL

## Token Efficiency Benchmark

The wire format (`wire-format.js`) uses compact encoding (columnar CSV with path interning, uniform-column hoisting, and internal-ID stripping) to reduce the token footprint of analysis responses inside Pi's context window.

Measured via `bench/bench-tokens.js` — runs real CLI commands against indexed repos, passes output through `compactResponse()`, and compares byte sizes.

### Results: Percentage Saved per Tool

| Tool | [PiMemoryExtension](https://github.com/GeneGulanesJr/PiMemoryExtension) | [Aether (PCBuilder)](https://github.com/GeneGulanesJr/Aether) |
| :--- | :---: | :---: |
| importance | 27% | 26% |
| hotspots | 48% | 0% |
| dead-code | 42% | **47%** |
| coupling | 33% | **39%** |
| extraction | 33% | 24% |
| cycles | 0% | 0% |
| import-graph | 24% | 20% |
| **OVERALL** | **36%** | **37%** |

### Total Savings

| | PiMemoryExtension | Aether (PCBuilder) |
| :--- | :---: | :---: |
| Repo size | 38 files · 210 symbols | 154 files · 1,359 symbols |
| Raw JSON | 42.6 KB | 181.7 KB |
| Compact format | 27.1 KB | 114.3 KB |
| Bytes saved | 15.5 KB | 67.4 KB |
| Tokens saved | ~4,445 tokens | ~19,242 tokens |

**Key findings:**
- Dead-code sees the biggest gains (42–47%) — the `signals` and `confidence` fields are uniform across rows and get hoisted, while `symbol_id` is stripped
- Coupling benefits from prefix interning on shared file paths (33–39%)
- Larger repos trend higher — Aether (154 files, 1,359 symbols) edged out PiMemoryExtension (38 files) at 37% vs 36%
- Cycles and very small result sets show no savings (no homogeneous lists to encode)

All transforms are **lossless round-trip** — verified by 217 tests in `test/wire-format.test.js`.

Run it yourself:
```bash
node bench/bench-tokens.js
```

## Development

Contributor-facing architecture and module ownership docs live in:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, testing expectations, dependency rules, and where new changes belong
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stable architecture overview for the modular monolith
- [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md) — quick reference for module purpose, entry points, allowed dependencies, and forbidden dependencies
- [`docs/ARCHITECTURE_MODULARIZATION.md`](docs/ARCHITECTURE_MODULARIZATION.md) — detailed modularization rationale and extraction plan

Common development commands:

```bash
npm test
npm run check
npm run format:check
```

The active repo still includes legacy-compatible root modules such as `commands/`, `services/`, `data-access/`, and `memory-store.js` while the backend is modularized. New feature work should follow the ownership boundaries in `docs/MODULE_MAP.md` and prefer finalized `src/` feature modules when they exist.

## License

MIT
