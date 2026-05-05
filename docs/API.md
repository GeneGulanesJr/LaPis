# API Reference

Complete API reference for the memory layer.

## Memory Store API

The memory store provides functions for saving, searching, and managing memories.

### `save(key, content)`

Saves a memory with the given key and content.

```js
const { save } = require('../memory-store');
save('project-context', 'This project uses Node.js and SQLite');
```

### `search(query)`

Searches memories matching the query string.

```js
const { search } = require('../memory-store');
const results = search('memory store');
console.log(results);
```

### `delete(key)`

Removes a memory by key.

## Doc Indexer API

The doc indexer provides documentation search and indexing capabilities.

### `indexDocs(path, name)`

Indexes all markdown files in the given path.

```js
const { indexDocs } = require('../doc-indexer');
indexDocs('./docs', 'pi-docs');
```

## Glossary

- **Index** — A data structure that enables fast lookup of documents by content.
- **Section** — A portion of a markdown file delimited by headings.
- **Backlink** — A reference from one document section to another.

## See Also

- [SKILL.md](SKILL.md) for the main skill overview
- [CONFIGURATION.md](CONFIGURATION.md) for configuration options
- [TUTORIAL.md](TUTORIAL.md) for usage tutorials
