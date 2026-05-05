# Memory Layer Skill

This is the main skill file for the memory layer extension.

## Overview

The memory layer provides persistent memory capabilities for AI agents. It integrates with the memory store to save and retrieve context across sessions.

## How to Use

To use the memory layer, you need to `require` the memory-store module in your project.

**Memory Store** — The core storage engine that persists memories to a local SQLite database.

**Doc Indexer** — Indexes markdown documentation for fast search and retrieval.

## Memory WASM Integration

The memory wasm module provides high-performance lookups for indexed code symbols. It uses a compact binary format for efficient storage and retrieval.

## Configuration

See [CONFIGURATION.md](CONFIGURATION.md) for setup details.

## Glossary

- **Symbol** — A named code entity such as a function, class, or variable.
- **Memory Store** — The SQLite-backed persistence layer for agent memories.
- **Doc Repo** — A collection of markdown files indexed for documentation search.

## Code Examples

### Basic Usage

```js
const store = require('../memory-store');
const result = store.save('my-memory', 'Important context about the project');
console.log(result);
```

### Advanced Query

```js
const store = require('../memory-store');
const memories = store.search('memory wasm performance');
for (const m of memories) {
  console.log(m.content);
}
```

## See Also

- [API.md](API.md) for the full API reference
- [TUTORIAL.md](TUTORIAL.md) for step-by-step guides
- [nonexistent-file.md](nonexistent-file.md) for an example broken link
