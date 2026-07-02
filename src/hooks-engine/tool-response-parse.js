'use strict';

/**
 * hooks-engine: tool-response-parse
 *
 * Parses rendered MCP tool_response text for Claude Code PostToolUse mirroring.
 * Marker format `[#<id>]` is owned here so render/parse stay in sync across the
 * Pi extension, MCP adapter, and Claude Code bridge.
 */

const MEMORY_ID_MARKER_RE = /\[#(\d+)\]/g;

/**
 * Normalize a PostToolUse tool_response into plain text for parsing.
 * Handles MCP content blocks, JSON envelopes, and raw strings.
 */
function extractResponseText(toolResponse) {
  if (toolResponse == null) {
    return '';
  }
  if (typeof toolResponse === 'string') {
    return toolResponse;
  }
  if (typeof toolResponse !== 'object') {
    return String(toolResponse);
  }

  if (Array.isArray(toolResponse.content)) {
    return toolResponse.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }

  if (typeof toolResponse.text === 'string') {
    return toolResponse.text;
  }

  try {
    return JSON.stringify(toolResponse);
  } catch {
    return String(toolResponse);
  }
}

/**
 * Extract all `[#id]` markers from text.
 */
function parseMemoryIds(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const ids = new Set();
  let m;
  MEMORY_ID_MARKER_RE.lastIndex = 0;
  while ((m = MEMORY_ID_MARKER_RE.exec(text)) !== null) {
    const id = Number(m[1]);
    if (Number.isFinite(id)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Parse memory IDs from a memory-search tool response.
 * Accepts formatted lines (`- [#42] ...`) and JSON `{ results: [{ id }] }`.
 */
function parseSearchResultIds(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const results = parsed?.results;
      if (Array.isArray(results)) {
        return results.map((r) => Number(r?.id)).filter((id) => Number.isFinite(id));
      }
    } catch {
      // Fall through to marker parsing.
    }
  }

  return parseMemoryIds(text);
}

/**
 * True when memory-save succeeded (saved or auto-merged), false for duplicates/errors.
 */
function wasSaveSuccessful(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }

  const trimmed = text.trim();
  if (/potential duplicate/i.test(trimmed)) {
    return false;
  }
  if (/^error:/i.test(trimmed) || /failed to save/i.test(trimmed)) {
    return false;
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.status === 'potential_duplicate' || parsed?.error) {
        return false;
      }
      if (parsed?.id != null || parsed?.auto_merged) {
        return true;
      }
    } catch {
      // Fall through.
    }
  }

  return /memory saved/i.test(trimmed) && parseMemoryIds(trimmed).length > 0;
}

module.exports = {
  MEMORY_ID_MARKER_RE,
  extractResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
};
