// Module boundary:
// Converts gateway.dispatch() results into the MCP CallToolResult shape.
// Dispatch returns one of:
//   - { error: '...' }                      → tool error
//   - { content: [{type:'text',text}], ...} → already MCP-shaped (rare from dispatch)
//   - any plain object                      → success, JSON-stringified as text
// This module normalizes all three into { content: [{type:'text',text}], isError }.

/**
 * Strip Pi-TUI emoji icons that add noise in non-TUI MCP clients.
 * Only removes a LEADING run of decorative icons on each line — mid-string
 * emoji inside data values (titles, snippets) are preserved, since they may
 * carry meaning.
 *
 * Structure: one or more decorative emoji/symbol chars, each optionally
 * followed by a variation selector (U+FE0F) or ZWJ (U+200D) joiner. The
 * joiner/selector chars are suffixes on a base emoji, NOT standalone
 * alternatives, so they live outside the base class (else a lone orphan
 * selector would remain — which is what originally happened with "⚠️").
 */
// Base decorative ranges, each optionally extended by FE0F/200D modifiers.
const LEADING_ICON_RUN =
  /^\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{200D}]*)+\s*/u;

function stripTuiArtifacts(text) {
  if (typeof text !== 'string') {
    return text;
  }
  return text
    .split('\n')
    .map((line) => line.replace(LEADING_ICON_RUN, '').trimEnd())
    .join('\n')
    .trim();
}

function truncate(text, max = 100000) {
  if (typeof text !== 'string') {
    return text;
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…[truncated by MCP adapter, ${text.length - max} chars omitted]`;
}

/**
 * @param {unknown} result - output from gateway.dispatch(cmd, args)
 * @returns {{ content: Array<{type:'text', text:string}>, isError?: boolean }}
 */
function toCallToolResult(result) {
  // Null/undefined — dispatch treats this as a failure
  if (result === null || result === undefined) {
    return {
      content: [{ type: 'text', text: 'No result returned from memory engine.' }],
      isError: true,
    };
  }

  if (typeof result !== 'object') {
    return {
      content: [{ type: 'text', text: truncate(String(result)) }],
    };
  }

  const r = result;

  // Explicit error envelope from dispatch
  if (Object.hasOwn(r, 'error') && r.error) {
    return {
      content: [{ type: 'text', text: truncate(`Error: ${r.error}`) }],
      isError: true,
    };
  }

  // Already in MCP content shape (dispatch sometimes forwards these)
  if (
    Array.isArray(r.content) &&
    r.content.length > 0 &&
    r.content.every((c) => c && typeof c === 'object' && c.type === 'text')
  ) {
    const text = r.content.map((c) => c.text).join('\n');
    return {
      content: [{ type: 'text', text: truncate(stripTuiArtifacts(text)) }],
      ...(r.isError === true ? { isError: true } : {}),
    };
  }

  // Plain object — serialize as formatted JSON. This is the common case for
  // Dispatch results (search results, outlines, analysis, etc.).
  let text;
  try {
    text = JSON.stringify(r, null, 2);
  } catch {
    text = String(r);
  }
  return {
    content: [{ type: 'text', text: truncate(stripTuiArtifacts(text)) }],
  };
}

module.exports = { toCallToolResult, stripTuiArtifacts, truncate };
// Re-export for tests that want to assert the regex is unused externally
module.exports.LEADING_ICON_RUN = LEADING_ICON_RUN;
