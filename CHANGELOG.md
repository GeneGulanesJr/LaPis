# Changelog

## Unreleased

### Added
- **Phase 3 — Claude Code guardrails + tracking + tool-state mirroring (#208)**
  - `PreToolUse` handler: Read, Grep (primary), Glob, and Bash search guardrails with actionable `memory-code` guidance; no auto-index on miss (manual `index-repo` guidance instead).
  - `PostToolUse` handler: edit tracking, async git-trust sync, and MCP tool-state mirroring (`memoriesSavedThisSession`, `pendingRecallFeedback`, `exploredFiles`).
  - New modules: `src/hooks-engine/tool-response-parse.js`, `src/claude-code/tool-map.js`, `src/claude-code/state-mutations.js`, `src/claude-code/handlers/pre-tool-use.js`, `src/claude-code/handlers/post-tool-use.js`.
  - Tests: `test/hooks-engine/tool-response-parse.test.js`, `test/claude-code/pre-post-tool-use.test.js`.
