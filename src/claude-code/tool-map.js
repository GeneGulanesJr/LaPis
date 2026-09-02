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
 * `mcp__<server>__` where the server name is `lapis` by default but
 * user-configurable via `lapis claude-code install --mcp-name`; mcpToolName()
 * strips any `mcp__<name>__` prefix so the rest of the bridge reasons about
 * the bare LaPis tool name. The install config's PreToolUse/PostToolUse
 * matchers are scoped to the installed server name, so in practice these
 * hooks only ever see the LaPis server's tools.
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

const MCP_PREFIX = 'mcp__lapis__',
  // Any MCP server name (Claude Code prefixes tools with `mcp__<server>__`).
  // A hardcoded `mcp__lapis__` here would silently kill tool-state mirroring
  // and guardrail seeding for installs that renamed the server via --mcp-name.
  MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__(.+)$/;

/**
 * Strip the `mcp__<server>__` prefix, returning the bare tool name (e.g.
 * `memory-code`) or null when the tool is not an MCP tool.
 */

/** True for any LaPis memory-* MCP tool (memory-save, memory-search, …). */

{
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
  function mcpToolName(toolName) {
    if (typeof toolName !== 'string') {
      return null;
    }
    const match = MCP_TOOL_RE.exec(toolName);
    return match ? match[1] : null;
  }
  function isMemoryMcpTool(toolName) {
    const bare = mcpToolName(toolName);
    return bare !== null && bare.startsWith('memory-');
  }
}
