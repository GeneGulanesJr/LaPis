'use strict';

/**
 * Hooks-engine: tool-response-parse
 *
 * Parses the `tool_response` Claude Code hands a PostToolUse hook for
 * `mcp__lapis__*` tools so the bridge can reconstruct the in-process `state`
 * mutations Pi's memory tools do synchronously (memory-save →
 * memoriesSavedThisSession++, memory-search → pendingRecallFeedback,
 * memory-get/delete → remove from it). In Claude Code the MCP server is a
 * separate process with no shared `state`, so the ONLY signal the hook has is
 * the rendered response text.
 *
 * This module owns the marker format (`[#<id>]`, `✅` save, `⚠️` duplicate) so
 * the render side (extensions/.../tools/memory-tools.ts) and this parse side
 * stay in sync. It is deliberately tolerant of format drift:
 *   - accepts string | content-block array | { content:[...] } | plain object
 *   - falls back to the structured JSON shape the MCP adapter emits
 *     (src/mcp/translate-result.js JSON-stringifies dispatch results) when the
 *     human-readable markers are absent.
 *
 * Pure JS, no Pi/extension imports — consumed by the Claude Code bridge
 * (src/claude-code/handlers/post-tool-use.js) and unit-tested directly.
 */

// `[#42]` (search/save render markers) and bare `#42` (get/delete headers).
const BRACKETED_ID_RE = /\[#(\d+)\]/g,
  BARE_ID_RE = /#(\d+)\b/g;

/**
 * Normalize whatever Claude Code put in `tool_response` into a single string.
 * MCP tool responses may arrive as:
 *   - a plain string (the serialized tool_result the model sees)
 *   - a content-block array: [{ type:'text', text:'…' }, …]
 *   - an object with a `content` array (CallToolResult shape)
 *   - an object with a `text` field
 *   - any other structured object (JSON-stringified as a last resort)
 */
function extractToolResponseText(toolResponse) {
  if (toolResponse === null || toolResponse === undefined) {
    return '';
  }
  if (typeof toolResponse === 'string') {
    return toolResponse;
  }
  if (Array.isArray(toolResponse)) {
    return toolResponse.map(extractToolResponseText).filter(Boolean).join('\n');
  }
  if (typeof toolResponse === 'object') {
    if (Array.isArray(toolResponse.content)) {
      return extractToolResponseText(toolResponse.content);
    }
    if (typeof toolResponse.text === 'string') {
      return toolResponse.text;
    }
    try {
      return JSON.stringify(toolResponse);
    } catch {
      return '';
    }
  }
  return String(toolResponse);
}

/** Collect a de-duplicated, order-preserving list of ids via a /g regex. */
function collectIds(text, re) {
  const ids = [],
    seen = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * All memory ids referenced anywhere in a tool response. Matches both the
 * `[#42]` list markers and bare `#42` headers (memory-get/delete). Used to
 * resolve which pendingRecallFeedback entries a get/delete "consumed".
 *
 * @param {*} toolResponse
 * @returns {number[]}
 */
function parseMemoryIds(toolResponse) {
  const text = extractToolResponseText(toolResponse),
    bracketed = text ? collectIds(text, BRACKETED_ID_RE) : undefined,
    bare = text ? collectIds(text, BARE_ID_RE) : undefined,
    seen = text ? new Set(bracketed) : undefined,
    merged = text ? [...bracketed] : undefined;
  if (!text) {
    return [];
  }
  for (const id of bare) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  if (merged.length > 0) {
    return merged;
  }
  return parseIdsFromJson(text);
}

/**
 * The ids of the results a memory-search returned, in order. Prefers the
 * `[#42]` render markers; falls back to the structured `{ results:[{id}] }`
 * JSON the MCP adapter emits.
 *
 * @param {*} toolResponse
 * @returns {number[]}
 */
function parseSearchResultIds(toolResponse) {
  const text = extractToolResponseText(toolResponse),
    bracketed = text ? collectIds(text, BRACKETED_ID_RE) : undefined;
  if (!text) {
    return [];
  }
  if (bracketed.length > 0) {
    return bracketed;
  }
  return parseIdsFromJson(text, 'results');
}

/**
 * Whether a memory-save response indicates a NEW memory was persisted. Returns
 * false for the potential-duplicate warning (`⚠️`, nothing saved), explicit
 * failures, and unparseable/empty responses.
 *
 * Render markers (memory-tools.ts):
 *   success   → "✅ Memory saved: [#42] …" / "✅ Memory saved [#42] … 🔄 Auto-merged"
 *   duplicate → "⚠️ Potential duplicate detected: …" (nothing saved)
 *   failure   → "Failed to save memory." / "Unexpected error: …"
 *
 * @param {*} toolResponse
 * @returns {boolean}
 */
function wasSaveSuccessful(toolResponse) {
  const text = extractToolResponseText(toolResponse);
  if (!text) {
    return false;
  }

  // Explicit duplicate / failure signals take precedence over a stray ✅.
  if (/potential duplicate/i.test(text) || text.includes('⚠️')) {
    return false;
  }
  if (/failed to save/i.test(text) || /unexpected error/i.test(text)) {
    return false;
  }

  if (text.includes('✅') && /saved/i.test(text)) {
    return true;
  }

  // Structured fallback: MCP adapter JSON. A save result carries a numeric
  // `id` and no `error`; a duplicate carries status:'potential_duplicate'.
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === 'object') {
    if (parsed.error) {
      return false;
    }
    if (parsed.status === 'potential_duplicate') {
      return false;
    }
    if (parsed.id !== undefined && parsed.id !== null) {
      return true;
    }
  }
  return false;
}

/** Best-effort JSON.parse; returns null on any failure. */
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Pull numeric ids out of the structured JSON shape the MCP adapter emits.
 * When `arrayKey` is given, only that array's element ids are returned;
 * otherwise a top-level `id` (single-record shapes) is used.
 */
function parseIdsFromJson(text, arrayKey) {
  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  if (arrayKey && Array.isArray(parsed[arrayKey])) {
    return parsed[arrayKey].map((r) => Number(r && r.id)).filter((id) => Number.isFinite(id));
  }
  if (!arrayKey) {
    if (Array.isArray(parsed.results)) {
      return parsed.results.map((r) => Number(r && r.id)).filter((id) => Number.isFinite(id));
    }
    if (parsed.id !== undefined && Number.isFinite(Number(parsed.id))) {
      return [Number(parsed.id)];
    }
  }
  return [];
}

module.exports = {
  extractToolResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
};
