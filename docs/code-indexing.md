# Async Code Indexing

By default, `lapis index-repo --path <repo>` blocks until indexing finishes. For large repos (>= 500 files by default) it now auto-switches to async and returns a job ID.

## Commands

```bash
# Synchronous (small repos) — blocks until done
lapis index-repo --path ./myrepo

# Explicit async (returns jobId immediately)
lapis index-repo-async --path ./myrepo --name myrepo

# Force async even on a small repo
lapis index-repo --path ./myrepo --async

# Poll progress
lapis index-status --job 42

# List recent jobs
lapis list-index-jobs
lapis list-index-jobs --running
```

## Extension tool

Inside the Pi extension, the `index-status` tool renders a progress bar, current file, and language breakdown:

```
⏳ Index job #42 (myrepo) — running
[█████████░░░░░░░░░░] 45% (90/200)
Current: src/cli/gateway.js
Languages: js=80, ts=10
```

## Configuration

- `LAPIS_ASYNC_INDEX_THRESHOLD` (env var) or `async_index_file_threshold` (config.jsonc) — file count that triggers auto-switch. Default: 500.

## How it works

- A V18 schema migration creates an `index_jobs` table that backs the job ledger.
- A `worker_threads` worker runs the actual `indexRepository` work. The CLI/extension tool reads job status from SQLite concurrently — WAL mode (already enabled) lets the reader and writer proceed without blocking.
- Progress is emitted via the existing `emitProgress` helper in `incremental-indexer.js`, now with an `onProgress` callback hook the worker uses to throttle-write ledger updates at most once per second.
- Language breakdown is derived from the current file via `getLanguageForFile()`.

## Notes

- Queries during an in-flight index return cached results; no special handling is needed because SQLite WAL already supports concurrent readers.
- The `index-status` extension tool reuses `renderCompactToolResult` so the agent sees a formatted text block, not raw JSON.
