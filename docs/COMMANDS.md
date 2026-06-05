# LaPis Commands

Most commands are called by Pi automatically through the memory-layer extension. They are listed here as the backend command reference for debugging, smoke testing, and manual development work.

## Observations and Search

| Command                 | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `save`                  | Save an observation such as a decision, bugfix, or pattern. |
| `update --id`           | Update an existing observation in-place by ID.        |
| `delete --id`           | Soft-delete an observation by ID.                     |
| `search`                | FTS5 full-text search with hybrid ranking.            |
| `search --include-code` | Search both memories and indexed code symbols.        |
| `context`               | Load session context by project.                      |
| `get --id`              | Retrieve a single observation by ID.                  |
| `timeline`              | List observations in chronological order.             |
| `suggest-topic-key`     | Suggest a topic key based on observation content.     |
| `check-dup`             | Check if a candidate observation duplicates an existing one. |
| `mark-dup`              | Mark an observation as a duplicate of another.        |

## Passive Capture

| Command             | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `save-prompt`       | Save the user's prompt for session tracking.          |
| `capture-passive`   | Auto-detect and save decisions/bugfixes/discoveries from assistant messages. |

## Code Indexing

| Command                                | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| `index-repo --path`                    | Index a local folder with tree-sitter.       |
| `reindex-repo --repo`                  | Incrementally reindex via mtime.             |
| `health-code-repo --repo`              | Report freshness, diagnostics, and index quality. |
| `search-code --query`                  | FTS5 BM25 search over code symbols.          |
| `ranked-code-context --query`          | Token-budgeted ranked code context for injection. |
| `get-code-source --repo --file --name` | Byte-accurate source retrieval.              |
| `list-code-repos`                      | List indexed code repos.                     |
| `remove-code-repo --repo`              | Remove an indexed code repo.                 |

Supported languages: JavaScript, TypeScript, TSX, Go, Python, Rust, and SQL.

## Agent Intelligence

| Command                   | Purpose |
| ------------------------- | ------- |
| `preflight --repo --task` | Before-coding check that combines code search, memory recall, related files/tests, docs, duplicate warnings, and recommended action. |
| `agent-pack --repo --task` | Compact Pi planning packet with must-read files, relevant symbols, past decisions, duplicate warnings, risk, and suggested plan. |

## Code Analysis

| Command                          | Purpose                                            |
| -------------------------------- | -------------------------------------------------- |
| `import-graph --repo`            | Import dependency graph with recursive traversal.  |
| `call-hierarchy --symbol --repo` | Call graph hierarchy.                              |
| `blast-radius --symbol --repo`   | What breaks if a symbol changes.                   |
| `dead-code --repo`               | Find unused code.                                  |
| `complexity --repo`              | Cyclomatic complexity per function.                |
| `outline --repo --file`          | File symbol outline.                               |
| `churn --repo`                   | Git commit frequency metrics.                      |

## Code Analytics

| Command                     | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `hotspots --repo`           | Top symbols by complexity times churn.         |
| `cycles --repo`             | Dependency cycles via Tarjan SCC.              |
| `importance --repo`         | Symbol PageRank on call graph.                 |
| `coupling --repo`           | Afferent, efferent, and instability per file.  |
| `extractable --repo`        | Refactoring candidates.                        |
| `hierarchy --symbol --repo` | Class hierarchy from parent names.             |
| `signal-chains --repo`      | Detect HTTP/CLI gateways and trace call chains. |
| `layer-violations --repo`   | Check imports against declared architecture layers. |
| `winnow --repo`             | Filter analysis results by confidence/type.    |
| `ast-patterns --repo`       | AST-based code smell and pattern detection.    |
| `provenance --repo`         | Git blame-based provenance for symbols.        |
| `untested --repo`           | Find symbols without test coverage.            |
| `pr-risk --repo`            | Assess risk of changes for PR review.          |
| `coding-context --repo`     | Unified before-edit context for a symbol or file. |

| Command                          | Purpose                                        |
| -------------------------------- | ---------------------------------------------- |
| `index-docs --path --name`       | Index a markdown doc tree.                     |
| `reindex-docs --repo`            | Re-index a doc repo.                           |
| `doc-search --query --repo`      | Full-text search across doc sections.          |
| `doc-outline --repo --file`      | Section hierarchy outline.                     |
| `backlinks --repo --path`        | Find docs that link to a given doc.            |
| `broken-links --repo`            | Find broken internal doc links.                |
| `glossary --repo --term`         | Look up glossary terms.                        |
| `tutorial-path --section --repo` | Reconstruct an ordered tutorial chain.         |
| `code-examples --query --repo`   | Search fenced code blocks by content.          |
| `doc-orphans --repo`             | Find sections with zero inbound links.         |
| `doc-coverage --repo`            | Which code symbols have documentation coverage. |
| `stale-pages --repo`             | Find docs modified since last index.           |
| `doc-duplicates --repo`          | Find duplicate sections by content hash.       |

## Symbol Links and Trust

| Command                          | Purpose                                              |
| -------------------------------- | ---------------------------------------------------- |
| `link-symbol --memory --symbol`  | Link a memory to a code symbol.                      |
| `auto-link --project`            | Automatically link memories to relevant code symbols. |
| `adjust-trust --id`              | Manually adjust trust score for a memory.            |
| `record-recall --id`             | Record that a memory was recalled in a session.      |
| `stale-links`                    | Find memory-to-symbol links that may be stale.       |
| `sync-code-trust --repo`         | Sync trust scores after git changes.                 |
| `symbol-cluster --symbol`        | Find all memories linked to a code symbol.           |
| `related --id`                   | Find memories linked to the same symbols.            |

## Sessions

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `session-start --project`  | Start a session, auto-recover incomplete sessions.   |
| `session-end --id`         | End a session with trust recovery.                   |
| `session-summary`          | Save a session summary.                              |
| `auto-recover --session`   | Auto-recover an incomplete session.                  |
| `recover-orphans`          | Recover orphaned sessions.                           |
| `trust-recovery`           | Run trust recovery for stale symbol links.           |

## Procedural Workflows

| Command                        | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `save-workflow`                | Save a named procedural workflow.                    |
| `record-step`                  | Record a step within a workflow.                     |
| `step-outcome`                 | Record the outcome of a workflow step.               |
| `get-workflow`                 | Retrieve a saved workflow and its steps.             |

## Workspace Management

| Command                    | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `list-workspaces`          | List all workspaces.                       |
| `create-workspace --name`  | Create a workspace.                        |
| `archive-workspace --name` | Archive a workspace while preserving data. |

## Maintenance

| Command         | Purpose                                      |
| --------------- | -------------------------------------------- |
| `init`          | Initialize the database schema.              |
| `compact`       | Prune dead links, decay trust, vacuum, and optimize FTS5. |
| `dream`         | Run stale-memory cleanup.                    |
| `stats`         | Show database statistics.                    |
| `list-projects` | List all known project names.                |

## HTTP Server

LaPis includes an optional HTTP server for programmatic access. Start it with:

```bash
node memory-store.js serve [--host HOST] [--port PORT]
```

Defaults to `127.0.0.1:9100`. The server exposes REST endpoints for missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings, sessions, memory search, costs, retry/rescope, compression, checkpoints, settings, and code indexing/analysis. See [`API.md`](API.md) for the full endpoint reference.

See [`DREAM_CYCLE.md`](DREAM_CYCLE.md) for the cleanup policy behind `dream`.
