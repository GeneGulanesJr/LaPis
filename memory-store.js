#!/usr/bin/env node
// Claude Code fires hooks (PreToolUse/PostToolUse/UserPromptSubmit/…) in a
// fresh process on every tool call and user prompt, so the hook router must
// not pay for the full CLI command-map module graph (~250ms measured). A
// concrete `hook <event>` invocation dispatches straight to the hook bridge;
// everything else (help, flags-only, install/doctor/serve/mcp/…) falls
// through to the unchanged full CLI.
if (
  process.argv[2] === 'claude-code' &&
  process.argv[3] === 'hook' &&
  process.argv[4] &&
  !process.argv[4].startsWith('-')
) {
  require('./src/claude-code/hooks').runHook(process.argv.slice(3));
} else {
  require('./cli');
}
