# ADR: Crosshash Migration Strategy

**Date:** 2026-05-15
**Status:** Proposed
**Deciders:** Gene Gulanes Jr.
**Supersedes:** N/A
**Related issues:** #85, #80, #81

## Context

LaPis (PiMemoryExtension) contains two parallel code-intelligence implementations:

1. **JS path** — `parse-code.js`, `code-analysis.js`, `git-analysis.js`, `ast-patterns.js`, `utils.js` (~1919 loc in code-index/analysis). On the v1.0.0 branch, these are being modularized into `src/code-index/` and `src/code-analysis/`. Supports 17 analysis modes via `memory-code` tool. Uses WASM tree-sitter for parsing, SQLite for storage. 960 JS tests passing.

2. **Crosshash Rust workspace** — 10 crates covering parsing (16 languages — 3 disabled due to tree-sitter version conflicts), BLAKE3 hashing, graph storage/traversal, git integration, AI edge discovery, impact analysis, HTTP API, MCP server. Exposes 9 MCP tools and CLI subcommands. 142 Rust tests passing (1 known failure from our HTML fix).

Both implementations share core concepts (symbol extraction, import/call edges, graph traversal, incremental indexing) but differ in scope, maturity, and deployment model.

## Evaluation

### Feature parity

| memory-code mode | Crosshash equivalent | Parity |
|---|---|---|
| index-repo | `crosshash index` | FULL |
| reindex-repo | `crosshash index --incremental` | PARTIAL — incremental logic differs (hash-based vs mtime-based) |
| callers | `graph callers` | FULL |
| callees | `graph callees` | FULL |
| blast-radius | `graph blast-radius` | FULL |
| cycles | `graph cycles` | FULL |
| dead-code | — | NONE |
| complexity | — | NONE |
| deps (import graph) | — | NONE |
| outline | — | NONE |
| churn | — | NONE |
| hotspots | — | NONE |
| importance | — | NONE |
| coupling | — | NONE |
| extractable | — | NONE |
| hierarchy | — | NONE |
| signal-chains | — | NONE |
| layer-violations | — | NONE |

**Crosshash also provides unique capabilities not in the JS path:**
- Cross-repository impact analysis (multi-repo graph traversal)
- AI-gated edge discovery with cost tracking
- BLAKE3 content hashing for entity identity
- Impact classification with SARIF output
- MCP stdio server and HTTP API
- File watching and live re-indexing
- Entity versioning and diffing

**Score: 2/5** — Crosshash covers 6/18 modes (index, reindex, callers, callees, blast-radius, cycles) but is missing 12 analysis modes. It adds unique multi-repo and AI capabilities absent from JS.

### Performance

Tested against the PiMemoryExtension repo (~260 JS files, ~200 Rust files, ~100 other).

| Operation | JS (Node.js) | Crosshash (Rust) | Ratio |
|---|---|---|---|
| Full index/reindex | 10.9s (262 files, 1960 symbols) | 57s (1244 files, 3599 entities, 61900 edges) | JS 5.2x faster |
| Callers query | 51ms | 127ms | JS 2.5x faster |
| Blast-radius query | 45ms | 358ms | JS 8x faster |
| Cycles query | 37ms | 147ms | JS 4x faster |

**Why JS is faster:**
- JS path is in-process — no binary startup, shared SQLite connection
- JS parses only JS/TS/Python/SQL (4 languages) vs Crosshash parsing 16+ languages
- Crosshash extracts significantly more data (61900 edges vs 32825 call edges + 489 import edges)
- Crosshash does BLAKE3 hashing per file on every index
- Query latency difference is dominated by process spawn overhead for Crosshash CLI

**Score: 2/5** — JS is significantly faster in the single-repo, in-process scenario that Pi uses. Crosshash's Rust performance advantage would only manifest in multi-repo or very large codebase scenarios (100k+ files) where parallelism and native code win.

### Pi extension compatibility

The `memory-code` tool in `extensions/memory-layer/index.ts` currently shells out to `node memory-store.js <mode>` with arguments. The extension captures stdout JSON and returns it to the LLM.

**Crosshash integration surfaces:**

| Boundary | Pros | Cons | Effort |
|---|---|---|---|
| CLI subprocess | Same pattern as current JS path. Drop-in for graph queries. | Process spawn per query (~120ms). Requires `crosshash` binary on PATH. 46MB binary distribution. | Low |
| MCP stdio | Persistent connection. Structured protocol. Already implemented. | Need MCP client code in extension. Crosshash process must stay alive. | Medium |
| HTTP API | Language-agnostic. Remote-capable. Already implemented (Axum). | Network overhead. Port management. | Medium |
| Node native addon (napi) | Fastest. No process boundary. | Complex build. Cross-compilation for 4+ platforms. Tree-sitter native deps. Very high risk. | Very High |

**Score: 3/5** — CLI subprocess is a reasonable drop-in for graph queries, but the 46MB binary distribution and process spawn overhead are significant drawbacks. MCP is promising but requires extension-side client code.

### Maintenance burden

**JS path code volumes (code-index + code-analysis):**
```
parse-code.js:     1040 loc  (tree-sitter parsing, symbol extraction)
code-analysis.js:   ~800 loc  (dispatch + analysis coordination)
git-analysis.js:    303 loc  (churn, provenance)
ast-patterns.js:    421 loc  (AST pattern scans)
utils.js:           154 loc  (file walking, hashing, ignores)
---------------------------------------------------
Total:             ~2718 loc across 5 files
```

**Crosshash Rust code:**
```
crosshash-core:      types, errors, edge semantics
crosshash-parser:    entity extraction, 16 language extractors
crosshash-hash:      BLAKE3 content hashing
crosshash-graph:     SQLite storage, edge extraction, graph traversal
crosshash-git:       git operations via libgit2
crosshash-impact:    impact analysis (hash diff + BFS + classification)
crosshash-ai:        AI edge discovery, LLM client, cost tracking
crosshash-api:       HTTP API (Axum)
crosshash-mcp:       MCP stdio server
crosshash-cli:       CLI interface (clap + indicatif)
---------------------------------------------------
Total:              ~15,000+ loc across 10 crates (estimated)
```

**Overlapping concepts:** Symbol extraction, import/call edges, graph traversal, incremental hashing, file walking/ignore, SQLite storage. Estimated ~60% conceptual overlap in the indexing/storage layer.

**JS-only capabilities:** Dead-code detection, cyclomatic complexity scoring, hotspot analysis, coupling metrics, class hierarchy, signal chains, layer violations, extractable candidates, untested symbols, PR risk assessment.

**Crosshash-only capabilities:** Cross-repo analysis, AI edge discovery, entity versioning, SARIF output, MCP server, HTTP API, BLAKE3 identity hashing.

**Build issues found during evaluation:**
- 3 grammar crates (dart, swift, zig) completely disabled due to tree-sitter version conflicts
- HTML indexing bug (fixed during evaluation)
- Duplicate test function in parser.rs (fixed during evaluation)
- OCaml and PHP grammar API naming mismatches (fixed during evaluation)

**Score: 2/5** — High duplication. Maintaining two codebases with 60% conceptual overlap is costly. The build fragility (tree-sitter version matrix) adds ongoing maintenance overhead. However, Crosshash provides unique multi-repo and AI capabilities that would be expensive to replicate in JS.

### Stability

| Metric | JS Path | Crosshash |
|---|---|---|
| Test count | 960 passing (1 file failing) | 142 passing (1 test failing from our fix) |
| Test coverage areas | Memory CRUD, search, code indexing, code analysis, doc indexing, trust sync, sessions | Graph traversal, entity extraction, multi-repo, AI edge discovery, CLI commands, MCP, API |
| Production usage | Live in Pi Agent extension, daily use | No production usage in Pi context |
| Build reliability | Node.js + npm, deterministic | Rust + tree-sitter native deps, version matrix issues |
| Error handling | Mature, scoped errors per command | Good for graph operations, newer for edge cases |

**Score: 3/5** — Crosshash has good test coverage for its core operations but lacks production seasoning in the Pi Agent context. The tree-sitter version compatibility issues discovered during evaluation are a stability concern.

### Migration cost

**To route `memory-code` calls to Crosshash (Option B — incremental):**

| Step | Effort | Risk |
|---|---|---|
| Add `crosshash` binary to Pi Agent distribution | 2-3 days | Medium — 46MB binary, 4+ platform builds |
| Create CLI adapter in extension (same pattern as JS) | 1-2 days | Low |
| Route graph queries (callers, callees, blast-radius, cycles) to Crosshash | 1-2 days | Low |
| Map Crosshash output format to `_meta` envelope | 2-3 days | Medium |
| Port remaining 12 analysis modes to Rust | 30-60 days | Very High |
| Feature flag infrastructure | 1-2 days | Low |
| Integration tests | 3-5 days | Medium |
| **Total (graph-only migration)** | **10-17 days** | Medium |
| **Total (full parity)** | **40-80 days** | Very High |

**Score: 3/5** — Routing the 6 overlapping modes to Crosshash is feasible in ~2 weeks. Full parity would take months and is high risk.

### Ecosystem risk

| Risk Factor | Assessment |
|---|---|
| Rust toolchain requirement | Pi Agent environments may not have Rust installed. Pre-built binaries required. |
| Binary size | 46MB release binary. Acceptable but larger than the JS path's footprint. |
| Cross-compilation | Need builds for: Linux x86_64, macOS ARM64, macOS x86_64, Windows x86_64. CI complexity. |
| Tree-sitter native deps | Grammar crates compile C code. Requires C compiler in build environment. |
| `rusqlite` bundling | SQLite is bundled, but build needs C compiler. Same as above. |
| npm ecosystem compatibility | Crosshash is outside npm. Extension must manage binary lifecycle. |
| Update cadence | Rust crates update independently. Tree-sitter version matrix requires ongoing maintenance. |

**Score: 3/5** — Binary distribution is feasible but adds CI/CD complexity. The tree-sitter version compatibility issues discovered during evaluation are a concrete risk.

## Scoring Summary

| Criterion | Weight | Score | Weighted |
|---|---|---|---|
| Feature parity | High | 2/5 | **2.0** |
| Performance | High | 2/5 | **2.0** |
| Pi extension compatibility | High | 3/5 | **3.0** |
| Maintenance burden | High | 2/5 | **2.0** |
| Stability | Medium | 3/5 | **1.8** |
| Migration cost | Medium | 3/5 | **1.8** |
| Ecosystem risk | Low | 3/5 | **0.9** |
| **Total (weighted)** | | | **15.5/35** |

## Decision

**Chosen: Option B — Incremental adoption**

### Rationale

Option B is the safest and most pragmatic choice:

1. **Crosshash does not have feature parity** (6/18 modes). Options A and D are premature — we can't replace JS yet, and we shouldn't abandon Crosshash's unique capabilities.

2. **Crosshash adds unique value** — cross-repo analysis, AI edge discovery, entity versioning, and the MCP/API surfaces. These are strategically important for the multi-repo and AI-assisted analysis roadmap.

3. **JS is faster in the current use case** — in-process, single-repo, small codebase. The JS path should remain the primary engine for Pi Agent `memory-code` queries.

4. **Maintenance burden is real but manageable** — the 60% conceptual overlap should be reduced over time by having Crosshash focus on what it does uniquely well (cross-repo, AI, versioning) and leaving single-repo analysis to the JS path.

5. **Build stability is a concern** — the tree-sitter version matrix issues discovered during evaluation need resolution before Crosshash can be promoted to canonical.

### Concrete strategy

1. **Keep JS `memory-code` as the canonical tool** for all 17 analysis modes in the Pi Agent extension.
2. **Add a `crosshash-code` tool** to the Pi extension as an experimental/advanced tool for:
   - Cross-repository impact analysis
   - AI-gated edge discovery
   - Entity diffing and versioning
   - SARIF report generation
3. **Do not duplicate graph query modes** — callers, callees, blast-radius, cycles stay in JS.
4. **Resolve tree-sitter compatibility** — either upgrade to 0.25 (and update all grammar APIs) or find compatible versions for all 19 languages.
5. **Re-evaluate in 3 months** — once the JS modularization (#80, #81) is complete and Crosshash build is stable, reassess Option A.

## Integration boundary

**Type: CLI subprocess** (for the experimental `crosshash-code` tool)

**Justification:**
- Same pattern as current `memory-store.js` invocation — minimal extension code changes.
- The `crosshash-code` tool will only be invoked for cross-repo/AI scenarios, not for routine single-repo queries.
- MCP stdio is the natural evolution once the tool stabilizes — persistent connection avoids per-query spawn overhead.

## Next steps

1. **Issue: Resolve tree-sitter version matrix** — Upgrade tree-sitter to 0.25 and update all grammar crate APIs, or find compatible versions for all 19 languages. Estimated: 3-5 days.

2. **Issue: Add `crosshash-code` Pi extension tool** — Register a new LLM tool in `extensions/memory-layer/` that shells out to the `crosshash` CLI for cross-repo and AI operations. Estimated: 3-5 days.

3. **Issue: Crosshash binary distribution** — Set up CI to build `crosshash` release binaries for Linux, macOS (ARM + x86), and Windows. Include in Pi Agent package or download on demand. Estimated: 2-3 days.

4. **Issue: Re-evaluate migration** — Create a follow-up issue with a 3-month horizon to reassess whether Crosshash should replace the JS graph query path. Depends on: JS modularization (#80, #81) being complete, tree-sitter compatibility resolved, and Crosshash having production usage data.

5. **No changes to JS `memory-code` modes** — Continue modularizing code-index (#80) and code-analysis (#81) per the existing plan. The JS path remains the canonical code intelligence engine.

## Rollback

This is a decision record. No code rollback needed. If the decision is reconsidered:
- To promote Crosshash to canonical: Create a superseding ADR with updated evaluation data.
- To archive Crosshash: Create an archival PR removing `crosshash/` from the workspace.
- To keep status quo: No action needed.
