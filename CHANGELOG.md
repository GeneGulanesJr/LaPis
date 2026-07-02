# Changelog

All notable changes to LaPis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
