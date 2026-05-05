# Tutorial

Step-by-step tutorial for using the memory layer extension.

## Getting Started

First, install the dependencies and require the memory store module in your application.

```js
const memory = require('../memory-store');
```

## Step 1: Save a Memory

Use the `save` function to persist important context:

```js
memory.save('decision:db-choice', 'We chose SQLite for its zero-config setup');
```

## Step 2: Search Memories

Retrieve memories using keyword search:

```js
const results = memory.search('database');
```

## Step 3: Index Documentation

Index your documentation for fast retrieval:

```js
memory.indexDocs('./docs', 'my-docs');
```

## Memory WASM Performance

The memory wasm module accelerates symbol lookups. When working with large codebases, the wasm backend provides significant speed improvements over pure JavaScript.

## Advanced Topics

### Combining Code and Doc Search

You can search across both code symbols and documentation:

```js
const codeResults = memory.search('memory store', { type: 'code' });
const docResults = memory.search('memory store', { type: 'doc' });
```

## Glossary

- **Persistence** — The ability to retain data across sessions or restarts.
- **Indexing** — The process of building a searchable catalog from source material.

## See Also

- [SKILL.md](SKILL.md) for the main skill documentation
- [API.md](API.md) for the complete API reference
