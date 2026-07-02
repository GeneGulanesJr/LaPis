# Changelog

All notable changes to LaPis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
