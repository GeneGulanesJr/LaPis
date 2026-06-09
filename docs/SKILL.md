# Memory Layer Skill

This is the companion skill doc for the `skills/memory-layer/SKILL.md` extension registration. For the authoritative and complete skill reference, see [`../skills/memory-layer/SKILL.md`](../skills/memory-layer/SKILL.md).

## Overview

The memory layer provides persistent memory capabilities for the Pi coding agent. It runs as a Pi extension with a local SQLite backend, providing observation CRUD, code indexing, code analysis, doc indexing, trust scoring, and session lifecycle management — all without cloud dependencies or API keys.

## Key Capabilities

- **Declarative memory** — save, search, update, and delete observations (decisions, bugfixes, patterns, discoveries).
- **Code indexing** — web-tree-sitter (WASM) parses JS/TS/TSX/Go/Python/Rust/SQL for semantic symbol lookup.
- **Code analysis** — import graphs, call hierarchies, blast radius, dead code, complexity, hotspots, cycles, importance, coupling, signal chains, layer violations, AST patterns, provenance, untested detection, PR risk, and unified coding context.
- **Doc indexing** — Markdown sections, links, glossary terms, code examples, broken link detection, tutorial path reconstruction.
- **Trust scoring** — memories linked to changed code lose confidence; stable linked code recovers trust.
- **HTTP server** — optional REST API for programmatic access to the Aurex domain model and code analysis.
- **Auto-detection** — the extension automatically captures decisions, bugfixes, and discoveries from assistant messages.

## See Also

- [`../skills/memory-layer/SKILL.md`](../skills/memory-layer/SKILL.md) — complete extension skill reference
- [`API.md`](API.md) — HTTP API and CLI reference
- [`TUTORIAL.md`](TUTORIAL.md) — step-by-step usage guide
- [`CONFIGURATION.md`](CONFIGURATION.md) — configuration options
- [`COMMANDS.md`](COMMANDS.md) — full CLI command reference
