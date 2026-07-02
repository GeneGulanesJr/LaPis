'use strict';

const BRACKET_ID_RE = /\[#(\d+)\]/g;
const HEADING_ID_RE = /(?:^|\n)##\s+#(\d+)\b/g;
const SEARCH_RESULT_ID_RE = /^\s*-\s+\[#(\d+)\]\s+/gm;

function normalizeToolResponseText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  if (Array.isArray(value.content)) {
    return value.content
      .map((entry) => (entry && typeof entry.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function collectIds(text, regexes) {
  const ids = [];
  const seen = new Set();
  const source = normalizeToolResponseText(text);
  for (const regex of regexes) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) !== null) {
      const id = Number.parseInt(match[1], 10);
      if (Number.isInteger(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function parseMemoryIds(text) {
  return collectIds(text, [BRACKET_ID_RE, HEADING_ID_RE]);
}

function parseSearchResultIds(text) {
  return collectIds(text, [SEARCH_RESULT_ID_RE]);
}

function wasSaveSuccessful(text) {
  const source = normalizeToolResponseText(text);
  return /\bMemory saved\b/.test(source) && !/Potential duplicate/i.test(source);
}

module.exports = {
  normalizeToolResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
};
