'use strict';

/**
 * Claude Code bridge: tool → handler category map.
 *
 * Documents which PreToolUse / PostToolUse behaviors apply per tool name.
 * Used by handlers for routing and by tests for coverage checks.
 */

const MCP_PREFIX = 'mcp__lapis__';

const PRE_TOOL_MAP = {
  Read: 'read-guardrail',
  Grep: 'search-guardrail',
  Glob: 'search-guardrail',
  Bash: 'search-guardrail',
};

const POST_TOOL_MAP = {
  Write: 'edit-track',
  MultiEdit: 'edit-track',
  Edit: 'edit-track',
  Bash: 'git-trust',
};

function mcpShortName(toolName) {
  if (!toolName || typeof toolName !== 'string') {
    return null;
  }
  if (!toolName.startsWith(MCP_PREFIX)) {
    return null;
  }
  return toolName.slice(MCP_PREFIX.length);
}

function preCategory(toolName) {
  if (toolName === 'Bash') {
    return PRE_TOOL_MAP.Bash;
  }
  if (PRE_TOOL_MAP[toolName]) {
    return PRE_TOOL_MAP[toolName];
  }
  const short = mcpShortName(toolName);
  if (short === 'memory-code') {
    return 'explored-seed';
  }
  if (short && short.startsWith('memory-')) {
    return 'reminder-reset';
  }
  return null;
}

function postCategory(toolName) {
  if (POST_TOOL_MAP[toolName]) {
    return POST_TOOL_MAP[toolName];
  }
  const short = mcpShortName(toolName);
  if (short && short.startsWith('memory-')) {
    return 'tool-state-mirror';
  }
  return null;
}

function isMcpLapisTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith(MCP_PREFIX);
}

module.exports = {
  MCP_PREFIX,
  PRE_TOOL_MAP,
  POST_TOOL_MAP,
  mcpShortName,
  preCategory,
  postCategory,
  isMcpLapisTool,
};
