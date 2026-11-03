# LaPis Commands

Most commands are called by Pi automatically through the memory-layer extension. They are listed here as the backend command reference for debugging, smoke testing, and manual development work.

All commands are invoked as:

```bash
node memory-store.js <subcommand> [--option value ...]
```

Results are returned as JSON to stdout.

## Observations and Search

| Command                 | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `save`                  | Save an observation such as a decision, bugfix, or pattern. |
| `update --id`           | Update an existing observation in-place by ID.        |
| `delete --id`           | Soft-delete an observation by ID.                     |
| `get --id`              | Retrieve a single observation by ID.                  |
| `search`                | FTS5 full-text search with hybrid ranking.            |
| `context`               | Load session context by project.                      |
| `timeline`              | List observations in chronological order.             |
| `check-dup`             | Check if a candidate observation duplicates an existing one. |
| `mark-dup`              | Mark an observation as a duplicate of another.        |
| `suggest-topic-key`     | Suggest a topic key based on observation content.     |
| `stats`                 | Show database statistics.                             |
| `log-negative-recall`   | Log a negative recall event for a memory.             |

## Passive Capture

| Command             | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `save-prompt`       | Save the user's prompt for session tracking.          |
| `capture-passive`   | Auto-detect and save decisions/bugfixes/discoveries from assistant messages. |

## Code Indexing

| Command                                | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| `index-repo --path`                    | Index a local folder with tree-sitter. Auto-switches to async for large repos. |
| `index-repo-async --path --name`       | Explicit async index. Returns a job ID immediately. |
| `index-status --job`                   | Poll progress of an async index job.         |
| `cancel-index --job`                   | Cancel a running async index job.            |
| `list-index-jobs [--running]`          | List recent index jobs (optionally only running). |
| `reindex-repo --repo`                  | Incrementally reindex via mtime.             |
| `health-code-repo --repo`              | Report freshness, diagnostics, and index quality. |
| `search-code --query`                  | FTS5 BM25 search over code symbols.          |
| `ranked-code-context --query`          | Token-budgeted ranked code context for injection. |
| `get-code-source --repo --file --name` | Byte-accurate source retrieval.              |
| `list-code-repos`                      | List indexed code repos.                     |
| `remove-code-repo --repo`              | Remove an indexed code repo.                 |

Supported languages: JavaScript, TypeScript, TSX, Go, Python, Rust, and SQL.

`index-repo` and `reindex-repo` refuse non-codebase directories: the home directory, standard user content dirs (`Documents`, `Downloads`, …), and the filesystem root are never indexable, and any directory without a `.git` entry requires an explicit `LAPIS_INDEX_ALLOW_NON_GIT=1` opt-out.

See [`docs/code-indexing.md`](code-indexing.md) for the async indexing pipeline and progress tool output.

## Agent Intelligence

| Command                   | Purpose |
| ------------------------- | ------- |
| `preflight --repo --task` | Before-coding check that combines code search, memory recall, related files/tests, docs, duplicate warnings, and recommended action. |
| `agent-pack --repo --task` | Compact Pi planning packet with must-read files, relevant symbols, past decisions, duplicate warnings, risk, and suggested plan. |
| `dupes --repo`            | Find near-duplicate code symbols within a repo. |
| `enrich-symbols --repo`   | Run AST-based enrichment for all symbols in a repo. |
| `symbol-meta --symbol-id` | Fetch enrichment metadata for a single symbol. |
| `audit-diff --repo --files` | Audit how a set of changed files affects risk, callers, and tests. |
| `runtime-ingest --repo --coverage` | Ingest a coverage report and persist hot/cold symbol state. |
| `hot-symbols --repo`      | Top symbols by coverage frequency. |
| `cold-symbols --repo`    | Bottom symbols by coverage frequency. |
| `blast --repo --symbol`   | Orchestrated blast-radius that combines code analysis and memory links. |
| `stale-flags --repo`      | Detect stale code patterns (e.g. `process.env.NODE_ENV` checks in non-dev code) and persist findings. |

## Verification

| Command | Purpose |
| ------- | ------- |
| `verify-scan [--base <ref>] [--path <dir>]` | Scan everything changed since the merge-base of `<ref>` (default `HEAD`) and HEAD, including uncommitted and untracked files, for prover bypasses. SPARK: added `pragma Assume`, `SPARK_Mode => Off` (also in `.adc` files), GNATprove annotations (warning), `Post => True`, `Pre => False`, fewer Pre/Post/Contract_Cases than before, changed contract lines in `.ads` (warning), any `.gpr` change (warning). Lean: `sorry`/`admit`, new `axiom`, `native_decide`. Exits 1 on high-severity findings. Exceptions go in a committed `.lapis-verify-allow.json`: `[{ "rule", "file", "reason" }]`, reason required; changing that file is itself reported. Run it in CI (`lapis verify-scan --base origin/main`): a local run is advisory, since anything with a shell can skip it. It reads only git and never opens the memory DB. |

To gate a SPARK or Lean project's pull requests, add a job like this (checkout needs full history to find the merge-base):

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- uses: actions/setup-node@v6
  with:
    node-version: '25'
- name: Prover-bypass scan
  env:
    BASE_REF: ${{ github.base_ref }}
  run: npx -y @genegulanesjr/lapis verify-scan --base "origin/$BASE_REF"
```

Protect `.lapis-verify-allow.json` and `.github/workflows/` with required review (for example CODEOWNERS), so a change can't approve its own exceptions or skip the scan.

### Check results (everyday projects)

When the agent runs a check in its shell tool, LaPis records the result automatically (Claude Code, Pi): `tsc`/`vue-tsc`, `eslint`, `vitest`, `jest`, `pytest`/`python -m pytest`, and package scripts such as `npm test`, `pnpm lint` or `yarn typecheck`. Output is recognised by each tool's own summary or error format, so `--version`, `--help`, truncated or unrelated output records nothing. Each run is tied to HEAD plus a fingerprint of uncommitted files, so a file is "changed since" only if it changed after the check ran.

The latest result per checker is shown to the agent before recalled memories, for example:

```
### Checks (last runs — hints, not proof; re-run after editing)
- **tsc** (4m ago): ✗ 3 failing: src/math.ts:4 TS2322 Type 'string' is not assignable to type 'number'.; …
- **vitest** (1h ago): ✓ clean (2 files changed since — re-run to confirm)
```

The **stop gate** (on by default; `verification.gate`, `LAPIS_VERIFY_GATE=0`) refuses the agent's "done" when, in this session, it edited files after a checker's last run, or a checker that had a run at session start now reports failures it didn't then. Failures that existed before the session never block, nothing blocks when the agent edited no files, and the gate gives up after `verification.gate_max_blocks` (3) reminders. In Claude Code it is a synchronous `Stop` hook; in Pi a follow-up message at `agent_end`. Re-run `lapis claude-code install` to add the new hooks to an existing install. Hermes shows the results in context but has no capture or gate yet.

| Command | Purpose |
| ------- | ------- |
| `capture-checks --command <cmd> --output <text> [--path <cwd>]` | What the hooks call: parse a check command's output and store the result. |
| `proof-state [--verifier NAME] [--path <dir>]` | The same latest-runs view the agent sees, as JSON (also `memory-code` mode `proof-state`). Includes `changed_since` per run. |

### Prover results

| Command | Purpose |
| ------- | ------- |
| `verify-ingest --report <path> [--format gnatprove\|neutral] [--path <dir>]` | Store a prover run for the repo at `--path` (default cwd), tied to its current HEAD. `<path>` is the GNATprove output folder (`obj/<profile>/gnatprove`, read from its `*.spark` files and `gnatprove.sarif`) or a verifier-neutral `.json`. Bare GNATprove file names are resolved to repo paths; a unit whose file isn't in the repo is rejected. The run is marked `dirty` when Ada, Lean or project files differ from HEAD. Origin is always `imported`: a report file can't claim to be signed. Re-ingesting the same report for the same commit returns the existing run (`duplicate: true`). |
| `proof-state [--verifier NAME] [--path <dir>]` | Latest run per verifier, with each unit's status: `proved`, `justified` (`pragma Annotate` or `pragma Assume`, never counted as proved), `unproved` (failed proof or flow checks, with the open checks), `not-analyzed` (body has `SPARK_Mode => Off`), or `stale`. A unit is stale when its file, or its Ada spec/body, changed since the run's commit, including uncommitted edits. A `.gpr`, `.adc` or Lake file change, or a run commit that no longer exists, makes every unit stale. |

Run GNATprove so it writes its files, then ingest the folder:

```bash
alr exec -- gnatprove -P demo.gpr --level=2 --report=all
lapis verify-ingest --report obj/development/gnatprove
lapis proof-state
```

The verifier-neutral format, for other provers or your own converter:

```json
{
  "verifier": "lean",
  "verifier_version": "4.20.0",
  "units": [
    {
      "file": "src/Demo.lean",
      "unit": "Demo.add_comm",
      "line": 12,
      "proved": 1,
      "unproved": 0,
      "justified": 0,
      "flow_errors": 0,
      "open_checks": []
    }
  ]
}
```

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

## Documentation

| Command                          | Purpose                                        |
| -------------------------------- | ---------------------------------------------- |
| `index-docs --path --name`       | Index a markdown doc tree.                     |
| `reindex-docs --repo`            | Re-index a doc repo.                           |
| `list-doc-repos`                 | List indexed doc repos.                        |
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
| `link-symbol --memory-id ID --symbol-id ID --repo X [--file PATH] [--trust N]` | Link a memory to a code symbol. `--file` records the symbol's file path so trust sync matches changes on (path, name). |
| `auto-link --project`            | Automatically link memories to relevant code symbols. |
| `adjust-trust --memory-id ID [--delta N] [--reason R]` | Manually adjust trust score for a memory.            |
| `record-recall --session-id ID --memory-id ID` | Record that a memory was recalled in a session.      |
| `stale-links --repo X`           | Find memory-to-symbol links that may be stale.       |
| `sync-code-trust --repo`         | Sync trust scores after git changes.                 |
| `symbol-cluster --repo X [--query Q]` | Find all memories linked to a code symbol.           |
| `related --memory-id ID [--repo X]` | Find memories linked to the same symbols.            |

## Sessions and Workspaces

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `session-start --project`  | Start a session, auto-recover incomplete sessions.   |
| `session-end --id`         | End a session with trust recovery.                   |
| `session-summary`          | Save a session summary.                              |
| `auto-recover --session`   | Auto-recover an incomplete session.                  |
| `recover-orphans`          | Recover orphaned sessions.                           |
| `trust-recovery`           | Run trust recovery for stale symbol links.           |
| `list-projects`            | List all known project names.                        |
| `list-workspaces`          | List all workspaces.                                 |
| `create-workspace --name`  | Create a workspace.                                  |
| `archive-workspace --name` | Archive a workspace while preserving data.           |

## Maintenance

| Command         | Purpose                                      |
| --------------- | -------------------------------------------- |
| `init`          | Initialize the database schema.              |
| `compact`       | Prune dead links, decay trust, vacuum, and optimize FTS5. |
| `dream`         | Run stale-memory cleanup.                    |
| `cleanup-sessions` | Retroactively consolidate `session_summary` observations and prune orphaned/empty sessions. Mirrors the per-session merge that the in-session Dream Cycle performs at turn 50. Safe to re-run. |
| `dashboard`     | Memory observability dashboard: health, statistics, and index quality. |

## Token Saver

| Command                 | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `run <command...>`      | Execute a command with output compression. Supports `--raw` (no compression), `--text` (text output), `--remember`, `--cwd <path>`. |
| `token-saver-stats`     | Show cumulative token-saver savings statistics.      |
| `token-saver-clear`     | Clear accumulated token-saver savings statistics.    |

## HTTP Server

LaPis includes an optional HTTP server for programmatic access. Start it with:

```bash
node memory-store.js serve [--host HOST] [--port PORT] [--api-key KEY]
```

Defaults to `127.0.0.1:9100`. The server exposes REST endpoints for missions, milestones, working units, handoffs, contracts, verdicts, broadcasts, findings, sessions, memory search, costs, retry/rescope, compression, checkpoints, settings, code indexing/analysis, the todo/ledger domain, and `POST /dispatch` (gateway dispatch for Claude Code daemon mode). See [`API.md`](API.md) for the full endpoint reference.

See [`DREAM_CYCLE.md`](DREAM_CYCLE.md) for the cleanup policy behind `dream`.

## MCP Server

Expose LaPis tools over the Model Context Protocol (stdio). Tools only — no hooks or session lifecycle.

```bash
node memory-store.js mcp
# or: lapis mcp / lapis-mcp mcp
```

Full setup, project detection, and capability comparison: [`MCP.md`](MCP.md).

## Claude Code Bridge

Commands for the [Claude Code CLI](https://code.claude.com/docs/en/overview) integration. Full setup guide: [`CLAUDE_CODE.md`](CLAUDE_CODE.md).

```bash
node memory-store.js claude-code <subcommand> [flags]
# or: lapis claude-code … / lapis-cc claude-code …
```

| Subcommand | Purpose |
| --- | --- |
| `install` | Write Claude Code config: MCP server (`.mcp.json` or `~/.claude.json`) + hooks (`.claude/settings.json`). Flags: `--global`, `--mcp-name <name>`, `--no-claude-md`, `--bin <path>`, `--auto-allow`, `--daemon`, `--daemon-port <port>`. |
| `uninstall` | Remove LaPis-owned MCP entries and hook handlers (sentinel-based; unrelated config left intact). Stops daemon if lockfile present. |
| `doctor` | Install self-check: `better-sqlite3` loads, DB writable, MCP `command`/`args` resolve, hooks present, session state store writable (reports TTL and directory size). Exit code 1 on failure. |
| `start` | Start the optional dispatch daemon (`lapis serve`). Flags: `--port`, `--host`, `--detached`. |
| `stop` | Stop the dispatch daemon and remove the lockfile. |
| `gc` | Sweep stale per-session state files from `~/.pi/memory/claude-sessions/`. Flag: `--max-age-hours N` (default from `LAPIS_SESSION_TTL_HOURS` or 24). |
| `hook <event>` | Internal hook router (invoked by Claude Code, not manually). Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`. Optional `--only <role>` / `--skip <role>` for split handlers. |

**Note:** Bash hooks use a single bare `Bash` matcher; compound commands like `cd repo && git pull` are classified inside the handler (not via install-time `if` prefix rules). See [`CLAUDE_CODE.md`](CLAUDE_CODE.md#hook--feature-mapping).

## Hermes Bridge

Commands for the [Hermes Agent](https://hermes-agent.nousresearch.com/) integration. Full setup guide: [`HERMES.md`](HERMES.md).

```bash
node memory-store.js hermes <subcommand> [flags]
# or: lapis hermes …
```

| Subcommand | Purpose |
| --- | --- |
| `install` | Write Hermes config: MCP server entry, hook entries, first-use consent, and the memory skill in `$HERMES_HOME/config.yaml` (+ skills dir). Flags: `--mcp-name <name>`, `--home <dir>`, `--no-hooks`, `--no-skill`. |
| `uninstall` | Reverse `hermes install`: remove LaPis-owned MCP sub-block, hook list items, allowlist approvals, and skill directory (other config untouched). |
| `doctor` | Install self-check: config file, MCP entry, hook command, native module, bundled skill. Exits 0 only when all checks pass. |
| `hook <event>` | Internal shell-hook bridge (invoked by Hermes, not manually). |
