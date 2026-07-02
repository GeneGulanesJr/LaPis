'use strict';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const MEMORY_TOOL_PREFIX = 'mcp__lapis__memory-';
const SEARCH_BASH_RE = /\b(rg|grep|ag|ack|find)\b/i;
const GIT_TRUST_RE = /\bgit\s+(pull|checkout|merge|rebase|reset|stash\s+pop)\b/;

const TOOL_MAP = Object.freeze({
  Read: 'read-guardrail',
  Grep: 'search-guardrail',
  Glob: 'search-guardrail',
  Bash: 'bash-dispatch',
  Write: 'edit-track',
  Edit: 'edit-track',
  MultiEdit: 'edit-track',
});

function normalizeMemoryToolName(toolName) {
  if (typeof toolName !== 'string') {
    return '';
  }
  if (toolName.startsWith(MEMORY_TOOL_PREFIX)) {
    return toolName.slice('mcp__lapis__'.length);
  }
  return toolName;
}

function isLapisMemoryTool(toolName) {
  return normalizeMemoryToolName(toolName).startsWith('memory-');
}

function isLapisMemoryCodeTool(toolName) {
  return normalizeMemoryToolName(toolName) === 'memory-code';
}

function isEditTool(toolName) {
  return EDIT_TOOLS.has(toolName);
}

function isSearchBash(toolName, input) {
  return toolName === 'Bash' && typeof input?.command === 'string' && SEARCH_BASH_RE.test(input.command);
}

function isGitTrustBash(toolName, input) {
  return toolName === 'Bash' && typeof input?.command === 'string' && GIT_TRUST_RE.test(input.command);
}

module.exports = {
  TOOL_MAP,
  MEMORY_TOOL_PREFIX,
  normalizeMemoryToolName,
  isLapisMemoryTool,
  isLapisMemoryCodeTool,
  isEditTool,
  isSearchBash,
  isGitTrustBash,
};
