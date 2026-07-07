# API Reference

Complete API reference for the LaPis memory layer, covering both the CLI interface and the optional HTTP server.

## CLI API

All commands are invoked through `memory-store.js`:

```bash
node memory-store.js <subcommand> [--option value ...]
```

Results are returned as JSON to stdout. See [`COMMANDS.md`](COMMANDS.md) for the full command reference with options.

### Common CLI Examples

```bash
# Save a decision
node memory-store.js save --title "Use SQLite" --content "Chose SQLite for zero-config local storage" --type decision

# Search memories
node memory-store.js search --query "database choice"

# Index a repo
node memory-store.js index-repo --path /path/to/project --name my-project

# Get code analysis
node memory-store.js import-graph --repo my-project
node memory-store.js hotspots --repo my-project
```

## HTTP Server API

LaPis includes an optional HTTP server for programmatic access to the Aurex domain model (missions, milestones, working units) and core memory/code features.

### Starting the Server

```bash
node memory-store.js serve [--host 127.0.0.1] [--port 9100]
```

Defaults to `127.0.0.1:9100`. Binding to `0.0.0.0` prints a network exposure warning.

### Health

| Method | Endpoint      | Purpose          |
| ------ | ------------- | ---------------- |
| GET    | `/health`     | Health check.    |

### Gateway dispatch (daemon mode)

| Method | Endpoint     | Purpose |
| ------ | ------------ | ------- |
| POST   | `/dispatch`  | Execute a gateway command. Body: `{ "cmd": "<command>", "args": { ... } }`. Returns the raw gateway JSON envelope (including `{ "error": ... }` for unknown commands). Used by Claude Code hook handlers when daemon mode is active (`lapis claude-code start` or `install --daemon`). |

Example:

```bash
curl -X POST http://127.0.0.1:9100/dispatch \
  -H "Content-Type: application/json" \
  -d '{"cmd":"session-start","args":{"project":"my-app"}}'
```

See [`CLAUDE_CODE.md`](CLAUDE_CODE.md) for daemon configuration and lockfile layout.

### Missions

| Method | Endpoint                  | Purpose                      |
| ------ | ------------------------- | ---------------------------- |
| POST   | `/missions`               | Create a new mission.        |
| GET    | `/missions`               | List all missions.           |
| GET    | `/missions/:id`           | Get a mission by ID.         |
| PATCH  | `/missions/:id/status`    | Update mission status.       |

### Milestones

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/missions/:missionId/milestones`     | Create a milestone.          |
| PATCH  | `/milestones/:id/status`              | Update milestone status.     |

### Working Units

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/milestones/:milestoneId/units`      | Create a working unit.       |
| GET    | `/milestones/:milestoneId/units`      | List units for a milestone.  |
| PATCH  | `/units/:id/status`                   | Update unit status.          |

### Handoffs

| Method | Endpoint                  | Purpose                      |
| ------ | ------------------------- | ---------------------------- |
| POST   | `/units/:unitId/handoff`  | Write a unit handoff note.   |

### Contracts

| Method | Endpoint                              | Purpose                          |
| ------ | ------------------------------------- | -------------------------------- |
| POST   | `/milestones/:milestoneId/contracts`  | Create a contract.               |
| POST   | `/contracts/:oldId/supersede`         | Supersede an existing contract.  |
| GET    | `/milestones/:milestoneId/contracts`  | Get contract history.            |

### Verdicts

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/verdicts`                           | Write a verdict.             |
| PATCH  | `/verdicts/:id`                       | Classify a verdict.          |
| GET    | `/milestones/:milestoneId/verdicts`   | Get verdicts for milestone.  |

### Broadcasts

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/broadcasts`                         | Write a broadcast.           |
| PATCH  | `/broadcasts/:id`                     | Transition broadcast status. |
| GET    | `/missions/:missionId/broadcasts`     | Get broadcasts for mission.  |

### Findings

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/findings`                           | Write a finding.             |
| PATCH  | `/findings/:id`                       | Transition finding status.   |
| GET    | `/missions/:missionId/findings`       | Get findings for mission.    |

### Sessions

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/sessions`                           | Register a session.          |
| GET    | `/milestones/:milestoneId/sessions`   | Get sessions for milestone.  |

### Memory

| Method | Endpoint          | Purpose                      |
| ------ | ----------------- | ---------------------------- |
| POST   | `/memory/search`  | Search memories via HTTP.    |

### Costs

| Method | Endpoint                      | Purpose                      |
| ------ | ----------------------------- | ---------------------------- |
| POST   | `/costs`                      | Log a cost entry.            |
| GET    | `/missions/:missionId/costs`  | Get costs for a mission.     |

### Retry / Rescope

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/milestones/:milestoneId/retry`      | Increment retry count.       |
| POST   | `/milestones/:milestoneId/rescope`    | Log a scope change.          |

### Compression

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/missions/:missionId/compression`    | Run context compression.     |

### Checkpoints

| Method | Endpoint                              | Purpose                      |
| ------ | ------------------------------------- | ---------------------------- |
| POST   | `/checkpoints`                        | Create a checkpoint.         |
| GET    | `/checkpoints/:id`                    | Get a checkpoint.            |
| PATCH  | `/checkpoints/:id`                    | Resolve a checkpoint.        |
| GET    | `/missions/:missionId/checkpoints`    | Get pending checkpoints.     |

### Todo Ledgers

| Method | Endpoint                                          | Purpose                              |
| ------ | ------------------------------------------------- | ------------------------------------ |
| POST   | `/todo-ledgers`                                   | Create a mission todo ledger.        |
| GET    | `/todo-ledgers`                                   | List mission todo ledgers.           |
| GET    | `/missions/:missionId/todo-ledger`                | Get the todo ledger for a mission.   |
| PATCH  | `/missions/:missionId/todo-ledger`                | Update the todo ledger.              |
| PATCH  | `/missions/:missionId/todo-ledger/status`         | Set the todo ledger status.          |
| POST   | `/missions/:missionId/todo-events`                | Record a mission-scoped event.       |
| GET    | `/missions/:missionId/todo-events`                | List mission-scoped events.          |

### Todo Items

| Method | Endpoint                                          | Purpose                              |
| ------ | ------------------------------------------------- | ------------------------------------ |
| POST   | `/missions/:missionId/todos`                      | Create a todo item for a mission.    |
| POST   | `/missions/:missionId/todos/bulk`                 | Bulk-create todo items.              |
| GET    | `/missions/:missionId/todos`                      | List todos by mission.               |
| GET    | `/todos`                                          | List all todos.                      |
| POST   | `/todos/search`                                   | Search todos.                        |
| POST   | `/missions/:missionId/todos/claim-next`           | Claim the next ready todo.           |
| GET    | `/todos/:todoId`                                  | Get a todo by ID.                    |
| PATCH  | `/todos/:todoId`                                  | Update a todo.                       |
| PATCH  | `/todos/:todoId/status`                           | Set todo status.                     |
| POST   | `/todos/:todoId/evidence`                         | Add evidence to a todo.              |
| POST   | `/todos/:todoId/notes`                            | Add a note to a todo.                |
| PATCH  | `/todos/:todoId/assignment`                       | Assign a todo.                       |
| GET    | `/todos/:todoId/context-query`                    | Get the context query for a todo.    |
| GET    | `/todos/:todoId/context`                          | Get the assembled context for a todo. |
| POST   | `/todos/:todoId/events`                           | Record a todo event.                 |
| GET    | `/todos/:todoId/events`                           | List todo events.                    |

### Settings

| Method  | Endpoint          | Purpose                      |
| ------- | ----------------- | ---------------------------- |
| GET     | `/settings/:key`  | Get a setting value.         |
| PUT     | `/settings/:key`  | Set a setting value.         |
| DELETE  | `/settings/:key`  | Delete a setting.            |

### Code Indexing and Analysis

| Method | Endpoint                  | Purpose                              |
| ------ | ------------------------- | ------------------------------------ |
| POST   | `/code/index`             | Index a repository.                  |
| POST   | `/code/reindex`           | Reindex a repository.                |
| GET    | `/code/health/:repo`      | Code repo health diagnostics.        |
| GET    | `/code/summary/:repo`     | Code repo summary statistics.        |
| GET    | `/code/graph/:repo`       | Dependency graph for a repo.         |
| GET    | `/code/hotspots/:repo`    | Hotspot analysis for a repo.         |

### Dashboard

The `dashboard` CLI command provides a memory observability overview. It is available as a CLI command only (`node memory-store.js dashboard`) and is not exposed as an HTTP endpoint.

## Repository Interfaces

Feature modules access storage through repository interfaces in `src/platform/storage/repositories/`:

| Repository      | File          | Used by                                 |
| --------------- | ------------- | --------------------------------------- |
| Aurex           | `aurex.js`    | HTTP server, missions/milestones/todo/ledger domain |
| Code index      | `code-index.js` | Code indexing and analysis features   |
| Doc index       | `doc-index.js`  | Documentation indexing features       |
| Memory          | `memory.js`    | Observation CRUD, search, context     |
| Trust sync      | `trust-sync.js` | Symbol links, trust scoring           |
| Analytics       | `analytics.js`  | Code quality analytics               |

## See Also

- [`COMMANDS.md`](COMMANDS.md) — full CLI command reference
- [`SKILL.md`](SKILL.md) — extension skill documentation
- [`CONFIGURATION.md`](CONFIGURATION.md) — configuration options
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — architecture overview
