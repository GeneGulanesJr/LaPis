# Changelog

All notable changes to LaPis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.1.4] - 2026-08-06

### Added

- **Hermes Agent integration — `lapis hermes install|uninstall|doctor|hook`**
  - New [`docs/HERMES.md`](docs/HERMES.md) — Hermes Agent setup, hook mapping, `LAPIS_HOME`, troubleshooting.
  - `src/hermes/install.js` wires `mcp_servers.lapis` + `hooks:` + `hooks_auto_accept` into `$HERMES_HOME/config.yaml`, first-use consent in `shell-hooks-allowlist.json`, and a bundled Hermes skill (`hermes/SKILL.md` → `$HERMES_HOME/skills/memory/lapis/`). Line-based YAML editor (`src/hermes/config-editor.js`) preserves comments and unknown keys.
  - `src/hermes/hook.js` — Hermes shell-hook dispatcher: `pre_tool_call` read guardrail (blocks whole-file reads of indexed code, reusing hooks-engine guardrails), `post_tool_call` fire-and-forget `sync-code-trust`, `on_session_end` best-effort close. Hooks fail open.
  - `src/hermes/uninstall.js` / `doctor.js` — sentinel-keyed reversal and install self-check (`lapis hermes doctor`).
  - `db.js` — `LAPIS_HOME` env override for the memory directory, so MCP servers and the CLI share one SQLite DB regardless of the host process `HOME`.
  - [`README.md`](README.md), [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md) — transport overview and ownership row.

- **Documentation sync — three transports and Claude Code integration**
  - New [`docs/MCP.md`](docs/MCP.md) — standalone MCP server setup, capability comparison, project detection, troubleshooting.
  - [`docs/INDEX.md`](docs/INDEX.md) — integration transports table, updated doc map (MCP, interactive diagrams), bridge env vars, refreshed test-count guidance.
  - [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — transport diagram, `hooks-engine`, MCP adapter, Claude Code bridge, `POST /dispatch`.
  - [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md) — `src/mcp/`, `src/platform/project-db.js` ownership rows.
  - [`docs/COMMANDS.md`](docs/COMMANDS.md) — `mcp` and `claude-code gc` subcommands; Bash handler classification note.
  - [`docs/API.md`](docs/API.md) — `POST /dispatch` daemon endpoint.
  - [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — Claude Code bridge env vars and per-session state paths.
  - [`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md) — daemon port re-install, `gc`, doctor observability cross-links.
  - [`docs/TUTORIAL.md`](docs/TUTORIAL.md) — Claude Code and MCP tutorial sections.
  - [`README.md`](README.md), [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/SKILL.md`](docs/SKILL.md) — transport overview and cross-links.

### Fixed

- **npm packaging: ship `scripts/`, `hermes/`, `prompts/` so the published package boots**
  - `package.json` `files` whitelist omitted `scripts/`, so the published package crashed on every subcommand (`MODULE_NOT_FOUND` for `scripts/cleanup-sessions`, eager-loaded by the CLI gateway). `scripts/`, `hermes/`, and `prompts/` are now shipped — the bundled Hermes skill and Pi prompts install correctly from npm installs.
  - `test/config.test.js` tilde-expansion tests are now hermetic (`vi.resetModules` + `vi.stubEnv('LAPIS_HOME')`), passing whether or not `LAPIS_HOME` is set in the ambient environment.
  - `docs/HERMES.md`: corrected stale "three hook entries" wording to five.

- **Memory layer: self-heal stale cached project key from path-resolved repo**
  - `before_agent_start` now uses anchored, deepest-path `resolveIndexedRepo` (matching `detectProject`) instead of first-match `startsWith` prefix resolution.
  - When the path-resolved repo name differs from the session-start cached key, `state.currentProject` self-heals so memory saves and the context banner use the correct project bucket.
  - `buildSourceLookupGuidance` uses the same repo resolution to avoid nested-repo and unanchored-prefix mismatches.
  - Regression tests cover mid-session rename self-heal and nested-repo non-regression.

- **Code correctness review fixes**
  - Export `runCompactCheap` / `runVacuum` from `services/dream.js` so `session-end` runs cheap compact and gated vacuum again.
  - Add `source_module` column to `file_scope_bindings` (migration V24); persist module paths in `insertScopeBindings`.
  - Scope resolver resolves import targets via `source_module` before falling back to `LIMIT 1`.
  - HTTP `POST /memory/search` and `GET /todos/:id/context` read `search().results` instead of treating the object as an array.
  - `listMissionLedgers` includes todos; `claimNextReadyTodo` honors `depends_on` completion.
  - Incremental reindex progress guards null `head_commit`; derived-index failures log to stderr.
  - Session-end vacuum gate uses per-project session count (same query as `sessionStart`).
  - `log-negative-recall` returns a structured error for invalid `--entries` JSON.
  - Document `claim-next` dependency semantics in `docs/API.md`; wildcard synthetic bindings inherit `source_module`.
  - HTTP E2E test asserts non-empty `POST /memory/search` results.
  - `listMissionLedgers` batch-loads todos in one query (no per-ledger N+1).
  - `claim-next` treats `implemented` dependencies as satisfied.
  - V10 migration DDL includes `source_module` on `file_scope_bindings`.

- **Code review correctness fixes (ranking, trust, migrations, security)**
  - Stop passive context injection from writing to `recall_log` (was poisoning `useful_ratio` ranking every turn).
  - FTS search path now includes `useful_count` (parity with LIKE fallback).
  - `trustRecovery` reads useful recalls from `recall_log` (`was_useful = 1`) plus `session_recalls`.
  - Migration guard corrected (`version >= 23`) so V23 (`repo_index_locks`) runs for DBs at version 22.
  - Consolidated orphan recovery uses a real `session_log.id` instead of an observation id.
  - Dream cycle uses cheap compact only (no mid-session `VACUUM`); `report.ok` reflects compact success.
  - Dream config cleanup requires an explicit `supersedes`/`duplicate` relation (not topic_key alone).
  - `pr-risk` uses `execFileSync` with git ref validation (prevents shell injection via `--branch`/`--base`).
  - HTTP server rejects request bodies larger than 1MB.
  - Ranking handles timestamps that already include a `Z` suffix.
  - Index worker wraps `ensureDb()` in error handling.

- **Code review security and correctness fixes**
  - Incremental reindex `changed-paths` now enforces repo path boundaries and secret-file skips (parity with full scanner).
  - Full reindex defers `clearRepoIndex` until the first successful write batch so parse failures preserve the existing index.
  - Per-repo index locks prevent concurrent full/incremental rebuilds from interleaving writes.
  - Dream Cycle "never recalled" cleanup counts only `was_useful = 1` recalls.
  - `markDuplicate` rejects identical source/target IDs.
  - Pi trust-sync hook recognizes `git -C <path>` commands (parity with Claude Code bridge).
  - Trust sync applies adjustments in a transaction and initializes `head_commit` on first sync without a one-commit diff penalty.
  - Trust sync adapter notifies only after successful sync.
  - HTTP server supports optional API key auth (`--api-key`, `LAPIS_HTTP_API_KEY`) and refuses `0.0.0.0` binds without a key.
  - `claimNextReadyTodo` uses an atomic update to prevent duplicate claims.
  - Bash guardrail no longer blocks grep outside indexed repos based on `currentProject` alone.
  - Session quit waits up to 2s for shutdown persistence work.
  - `schema.sql` synced with `expires_at` on observations and the `index_jobs` table.
  - crosshash `serve` refuses unspecified bind addresses without `--api-key`.
  - Full reindex parses to memory first, then clears and writes in one SQLite transaction.
  - Cross-process repo index locks stored in `repo_index_locks` (SQLite).
  - Incremental `changed-paths` responses include `rejected_paths` for blocked entries.
  - HTTP auth documented in `docs/CONFIGURATION.md`; `::` bind requires API key.
  - Second review pass: defer diagnostics during buffered full rebuild; git delta path guards; derived-phase failure returns partial error; constant-time API key compare.
  - Third review pass: `updateRepoStats` runs after derived indexes succeed; incremental no-op reindex advances `head_commit` when git moved; trust sync resolves git-relative paths to indexed absolute paths; shared git-trust matcher supports quoted `-C` paths; HTTP auth accepts array-shaped headers.
  - Fourth review pass: trust sync uses `git diff --name-status` (rename old+new paths); scan-hash no-op reindex advances `head_commit`; HTTP Bearer scheme is case-insensitive.

- **Documentation review nits (PR #241)**
  - [`docs/MCP.md`](docs/MCP.md) — `lapis-mcp` requires the `mcp` subcommand; fix source links for `hooks-engine/project` and `project-db`; add `index-status` tool; clarify no `./mcp` npm export.
  - [`docs/COMMANDS.md`](docs/COMMANDS.md), [`docs/INDEX.md`](docs/INDEX.md) — align MCP bin invocation with CLI routing.
  - [`docs/TUTORIAL.md`](docs/TUTORIAL.md) — tidy See Also list formatting.

- **Claude Code bridge — issue #205 review follow-ups**
  - **Monorepo project detection:** `resolveProjectKey` / `resolveIndexedRepo` in
    `hooks-engine/project.js` prefer indexed repo path prefix over cwd basename,
    so git-trust sync and guardrails work from subdirectories like
    `packages/foo` when the repo is indexed as `my-monorepo`.
  - **Session summary count:** `SessionEnd` summary text now uses the same
    DB-derived memory count as `session-end` dispatch (not the mirrored counter).
  - **Stop checkpoint race:** progress checkpoints snapshot state under
    `mutateState` instead of an unlocked `loadState`.
  - **State lock budget:** `mutateState` lock timeout raised to 5s to reduce
    fail-open races under parallel PostToolUse hooks.
  - **MCP project key:** `detectMcpProject()` uses hooks-engine path-prefix
    resolution so MCP and the Claude Code bridge agree in monorepos.
  - **knownProjects fallback:** handlers and MCP load memory project names from
    the DB (list-projects parity) when cwd is not inside an indexed code repo.
  - **Nested repo match:** `findMatchingRepo` prefers the deepest matching path
    when several indexed repos overlap.
  - **Compact cwd refresh:** `SessionStart(compact)` updates `currentProject`
    when cwd resolves to a different project key.
  - **Polish:** MCP `detectMcpProject` reuses `dispatch-client` DB helpers;
    `SessionEnd` summary uses `resolveCwd` for relative file paths.
  - **Shared project DB reads:** `src/platform/project-db.js` centralizes
    `getKnownRepos` / `getKnownProjects` (5 min in-process cache); MCP no
    longer imports from `claude-code/`.
  - **Context injection:** `assembleContextLines` honors `CLAUDE_PROJECT_DIR`
    via `resolveCwd` for repo matching and index hints.
  - **`resolveCwd`:** prefers `CLAUDE_PROJECT_DIR` over payload `cwd` when set
    (aligns with hooks-engine module contract).

- **Claude Code bridge — issue #205 post-review hardening** (follow-up to #234).
  - **Stop / UserPromptSubmit state races (#228):** Stop and UserPromptSubmit now
    route all state writes through `mutateState` instead of unlocked load/save,
    so parallel PostToolUse hooks are not clobbered by stale snapshots.
  - **Path normalization (#227, #230):** `fileKey` / read-guardrail lookups and
    `findMatchingRepo` normalize `/` vs `\` so Windows and mixed-separator paths
    match correctly.
  - **`sanitizeKey`:** case-insensitive rejection of placeholder session ids
    (`Undefined`, `NaN`, …).
  - **Git trust sync:** `git -C <path> pull` (and similar) now trigger
    `sync-code-trust`.
  - **Edit-track:** `MultiEdit` / `Edit` `edits[]` paths are recorded.
  - **UserPromptSubmit timeout:** cancelled flag prevents state persistence after
    the 30s budget fires.
  - **Stop capture lock scope:** gateway dispatches (passive capture, dream,
    negative-recall) run outside the `mutateState` file lock so parallel
    PostToolUse hooks are not blocked for dispatch duration.
  - **Read guardrail:** repo path matching uses the same separator normalization
    as `findMatchingRepo`.
  - **Shared `makeMutate`:** extracted to `src/claude-code/state-mutate.js`.

- **Claude Code bridge — Phase 1–6 review polish** (#234 follow-up).
  - `uniqueEditedPaths` dedupes dual full-path + basename `editedFiles` entries
    before session summaries, checkpoints, and `audit-diff` (storage shape
    unchanged for read-guardrail matching).
  - Updated stale `post-tool-use.js` module comment to reflect `mutateState` locking.
  - Test coverage for `mutateState` lock-timeout fail-open path.

### Added

- **Claude Code bridge — Phase 6: docs + package.json + polish** (#211, part of #205).
  - New [`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md) — install guide, hook → feature mapping,
    two-config layout, state storage, first-use MCP approval, deliberate Pi divergences,
    troubleshooting (silent DB init, stdio-only errors, hooks fail open), and deferred
    output-compression follow-up.
  - README "Use with Claude Code" install subsection; updates to
    [`docs/COMMANDS.md`](docs/COMMANDS.md), [`docs/INDEX.md`](docs/INDEX.md),
    [`docs/SKILL.md`](docs/SKILL.md).
  - `package.json`: explicit `src/claude-code/` + `src/hooks-engine/` in `files`;
    `"./claude-code"` export; optional `lapis-cc` bin alias.
  - Review polish: hook table adds `MultiEdit` and PostToolUse `memory-code` harvest;
    documents `lapis-cc` alias; fixes relative doc links.

- **Claude Code bridge — Phase 5: daemon mode + POST /dispatch (optional perf tier)** (#210, part of #205).
  - `POST /dispatch` on the existing HTTP server — wraps `gateway.dispatch(cmd, args)`
    and returns the raw gateway JSON (including `{error}` envelopes for unknown cmds).
  - `dispatch-client.js` auto-selects daemon mode when `LAPIS_DAEMON_URL` or the
    daemon lockfile (`~/.pi/memory/claude-daemon.json`) points at a live process;
    falls back to direct in-process dispatch when unavailable.
  - `lapis claude-code start [--port 9100] [--host 127.0.0.1] [--detached]` /
    `lapis claude-code stop` — manage the shared-dispatch daemon (wraps `lapis serve`).
  - `lapis claude-code install --daemon [--daemon-port 9100]` — opt-in perf tier that
    starts a detached daemon after install and writes the lockfile for hook handlers.
  - Uninstall stops a running daemon when its lockfile is present; failed detached
    starts kill the spawned child instead of leaving an orphan process.

- **Claude Code bridge — Phase 4: install + CLI + doctor (direct dispatch)** (#209, part of #205).
  - `lapis claude-code install` — config writer for Claude Code's two separate
    config systems (never mixed):
    - MCP server → `.mcp.json` (project scope, committable, default), or
      `~/.claude.json` user scope (`--global`) / local scope (machine-specific
      `--bin` paths).
    - Hooks → `.claude/settings.json` (project), `~/.claude/settings.json`
      (`--global`), or `.claude/settings.local.json` (machine-specific `--bin`).
    - Exec-form command hooks throughout; SessionStart `startup|resume|clear`
      and `compact` as separate matcher groups; `PreToolUse` gated by
      `Read|Grep|Glob`, per-command `Bash(…)` `if` rules, and `mcp__<name>__.*`;
      no matcher on always-fire events; `async: true` on heavy handlers (Stop
      capture and the `--only git-trust` PostToolUse split).
    - `.claude/CLAUDE.md` memory-usage protocol block (append-only, delimited
      by `<!-- lapis:start -->`/`<!-- lapis:end -->`; skip with `--no-claude-md`).
    - Flags: `--global`, `--mcp-name <name>`, `--no-claude-md`, `--bin <path>`,
      `--auto-allow` (adds `permissions.allow: ["mcp__<name>__*"]`, default off).
    - Idempotent re-install: hook handlers replaced by sentinel identity, MCP
      servers deduped by name + resolved command string.
  - `lapis claude-code uninstall` — sentinel-based reversal; unrelated hooks,
    servers, permissions, and CLAUDE.md prose are left intact; files that end
    up empty are removed (`~/.claude.json` is only ever mutated, never deleted).
  - `lapis claude-code doctor` — install self-check: better-sqlite3 loads, DB
    writable, MCP `command`/`args` resolve (PATH lookup or script existence),
    hooks present, session state store writable. Non-zero exit on failure.
  - Hook router: `--only <role>` / `--skip <role>` flags let the install config
    split one Claude Code event across a synchronous handler (tracking and
    tool-state mirroring) and an async one (git-trust) without double-firing.

- **Claude Code bridge — Phase 3: guardrails + tracking + tool-state mirroring** (#208, part of #205).
  - `PreToolUse` guardrails wired into the hook router:
    - `Read` — blocks whole-file reads of indexed code, with bypasses for
      `offset`/`limit`, config files, `node_modules`, cross-project reads, and
      already-explored files.
    - `Grep` (PRIMARY code-search guardrail) — blocks broad/regex searches in an
      indexed repo; allows targeted single-symbol lookups and single-file scopes.
    - `Glob` (secondary) — blocks broad recursive discovery (`**/*`, `**/*.ext`);
      allows scoped globs.
    - `Bash` (secondary) — blocks raw `grep`/`rg`/`ag`/`ack`/`find` in an indexed
      repo; allows piped output filters and targeted symbol lookups.
    - `mcp__lapis__memory-code` seeds `exploredFiles`; any `mcp__lapis__memory-*`
      resets the memory-reminder cadence.
    - Auto-index on miss is deferred (documented divergence from the Pi extension)
      to protect the hook timeout budget.
  - `PostToolUse` tracking + tool-state mirroring (process-boundary fix):
    - `Write`/`MultiEdit`/`Edit` record edited files.
    - `Bash` git ops (`pull`/`checkout`/`merge`/`rebase`/`reset`/`stash pop`)
      trigger `sync-code-trust`.
    - `mcp__lapis__memory-save` (success only) increments the session save counter.
    - `mcp__lapis__memory-search` populates `pendingRecallFeedback` (restores the
      negative-recall feedback loop across the MCP↔hook process boundary).
    - `mcp__lapis__memory-get`/`memory-delete` mark recalled memories useful.
    - `mcp__lapis__memory-code` harvests file paths into `exploredFiles`.
  - New engine module `src/hooks-engine/tool-response-parse.js`
    (`parseMemoryIds`, `parseSearchResultIds`, `wasSaveSuccessful`,
    `extractToolResponseText`) — owns the `tool_response` marker format so render
    and parse stay in sync; tolerant of content-block, string, and structured
    JSON shapes.
  - New `src/claude-code/tool-map.js` — single source of truth mapping Claude
    Code tool names to PreToolUse/PostToolUse roles.
  - Extended `src/hooks-engine/guardrail-utils.js` with `isTargetedGrepLookup`,
    `isBroadGlob`, and `isSpecificCodeFilePath` for the native-tool guardrails.
  - Tests: `test/hooks-engine/tool-response-parse.test.js`,
    `test/claude-code/tool-hooks.test.js`, plus guardrail-utils and router
    coverage.

## [1.1.3] - 2026-06-15

Published to npm without a separate changelog cut; changes are captured in the [1.1.4] record and git history.

## [1.1.2] - 2026-05-25

Published to npm without a separate changelog cut; changes are captured in the [1.1.4] record and git history.

## [1.0.0] - 2026-05-25

Initial release. Published to npm without a separate changelog cut; changes are captured in the [1.1.4] record and git history.
