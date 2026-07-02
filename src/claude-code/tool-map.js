'use strict';

/**
 * Claude Code bridge: tool map.
 *
 * Single source of truth for routing a Claude Code `tool_name` to a Phase 3
 * guardrail/tracking role. Both PreToolUse (pre-tool-use.js) and PostToolUse
 * (post-tool-use.js) switch on the role returned here so the tool→behavior
 * wiring lives in one place.
 *
 * Native tools keep their Claude Code names (`Read`, `Grep`, `Glob`, `Bash`,
 * `Write`, `Edit`, `MultiEdit`). LaPis MCP tools arrive prefixed with
 * `mcp__lapis__` (see Claude Code MCP tool naming); mcpToolName() strips that
 * so the rest of the bridge reasons about the bare LaPis tool name.
 *
 * Verified hook → role mapping (issue #208):
 *   PreToolUse:
 *     Read                       → read-guardrail
 *     Grep                       → search-guardrail   (PRIMARY)
 *     Glob                       → glob-guardrail      (secondary)
 *     Bash(grep|rg|find|…)       → bash-guardrail      (secondary)
 *     mcp__lapis__memory-code    → memory-code-seed
 *     mcp__lapis__memory-*       → memory-reminder-reset
 *   PostToolUse:
 *     Write|MultiEdit|Edit       → edit-track
 *     Bash(git …)                → git-trust
 *     mcp__lapis__memory-save    → memory-save-mirror
 *     mcp__lapis__memory-search  → memory-search-mirror
 *     mcp__lapis__memory-get     → memory-get-mirror
 *     mcp__lapis__memory-delete  → memory-get-mirror (delete also consumes recall)
 *     mcp__lapis__memory-code    → memory-code-harvest
 */

const MCP_PREFIX = 'mcp__lapis__';

/**
 * Strip the `mcp__lapis__` prefix, returning the bare LaPis tool name (e.g.
 * `memory-code`) or null when the tool is not a LaPis MCP tool.
 */
function mcpToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_PREFIX)) {
    return null;
  }
  return toolName.slice(MCP_PREFIX.length);
}

/** True for any LaPis memory-* MCP tool (memory-save, memory-search, …). */
function isMemoryMcpTool(toolName) {
  const bare = mcpToolName(toolName);
  return bare !== null && bare.startsWith('memory-');
}

const EDIT_TOOLS = new Set(['Write', 'MultiEdit', 'Edit']);

/**
 * Classify a tool for the PreToolUse hook.
 * @returns {string|null} role or null (no-op)
 */
function preToolRole(toolName) {
  const bare = mcpToolName(toolName);
  if (bare === 'memory-code') {
    return 'memory-code-seed';
  }
  if (bare && bare.startsWith('memory-')) {
    return 'memory-reminder-reset';
  }
  switch (toolName) {
    case 'Read':
      return 'read-guardrail';
    case 'Grep':
      return 'search-guardrail';
    case 'Glob':
      return 'glob-guardrail';
    case 'Bash':
      return 'bash-guardrail';
    default:
      return null;
  }
}

/**
 * Classify a tool for the PostToolUse hook.
 * @returns {string|null} role or null (no-op)
 */
function postToolRole(toolName) {
  if (EDIT_TOOLS.has(toolName)) {
    return 'edit-track';
  }
  if (toolName === 'Bash') {
    return 'git-trust';
  }
  const bare = mcpToolName(toolName);
  switch (bare) {
    case 'memory-save':
      return 'memory-save-mirror';
    case 'memory-search':
      return 'memory-search-mirror';
    case 'memory-get':
    case 'memory-delete':
      return 'memory-get-mirror';
    case 'memory-code':
      return 'memory-code-harvest';
    default:
      return null;
  }
}

module.exports = {
  MCP_PREFIX,
  mcpToolName,
  isMemoryMcpTool,
  preToolRole,
  postToolRole,
  EDIT_TOOLS,
};
