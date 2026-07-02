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

function parseToolResponseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !Array.isArray(value.content)) {
    return value;
  }
  const source = normalizeToolResponseText(value).trim();
  if (!source || (!source.startsWith('{') && !source.startsWith('['))) {
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function parseId(value) {
  const id = Number.parseInt(String(value), 10);
  return Number.isInteger(id) ? id : null;
}

function collectStructuredIds(value) {
  const parsed = parseToolResponseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const ids = [];
  const seen = new Set();
  for (const key of ['id', 'memory_id', 'memoryId']) {
    const id = parseId(parsed[key]);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function collectIds(text, regexes) {
  const ids = [];
  const seen = new Set();
  for (const id of collectStructuredIds(text)) {
    seen.add(id);
    ids.push(id);
  }
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
  const parsed = parseToolResponseJson(text);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.results)) {
    const ids = [];
    const seen = new Set();
    for (const result of parsed.results) {
      const id = result && typeof result === 'object' ? parseId(result.id) : null;
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }
  return collectIds(text, [SEARCH_RESULT_ID_RE]);
}

function wasSaveSuccessful(text) {
  const parsed = parseToolResponseJson(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.error || parsed.status === 'potential_duplicate') {
      return false;
    }
    return parseId(parsed.id) !== null;
  }
  const source = normalizeToolResponseText(text);
  return /\bMemory saved\b/.test(source) && !/Potential duplicate/i.test(source);
}

module.exports = {
  normalizeToolResponseText,
  parseToolResponseJson,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
};
