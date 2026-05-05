# Configuration Guide

This guide covers configuration options for the memory layer extension.

## Basic Setup

To get started, you need to `require` the configuration module:

```js
const config = require('./config');
config.loadDefaults();
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MEMORY_DB_PATH` | Path to the SQLite database file |
| `DOC_INDEX_PATH` | Root directory for indexed documentation |

## Memory Store Configuration

The memory store supports persistent storage of agent memories. Configure the database path to control where data is saved.

## Glossary

- **Agent** — An autonomous process that can store and retrieve memories.
- **Context Window** — The limited amount of information an AI can process at once.

## See Also

See [SKILL.md](SKILL.md) for the main skill documentation.
