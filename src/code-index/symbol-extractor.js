const crypto = require('crypto');
const path = require('path');
const { createParserRegistry } = require('./parser-registry');

function safeJson(value, fallback = []) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(text || '')
    .digest('hex');
}

function sliceByBytes(content, startByte, endByte) {
  if (!Number.isFinite(startByte) || !Number.isFinite(endByte) || endByte <= startByte) {
    return '';
  }
  return Buffer.from(content || '', 'utf-8').toString('utf-8', startByte, endByte);
}

function extractDecorators(source) {
  const decorators = [];
  for (const line of (source || '').split('\n').slice(0, 12)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@')) {
      decorators.push(trimmed.split(/[\s(]/)[0]);
    }
  }
  return decorators;
}

function extractKeywords(symbol, source) {
  const text = [
      symbol.name,
      symbol.qualified_name,
      symbol.kind,
      symbol.signature,
      symbol.docstring,
      symbol.parent_name,
      source,
    ]
      .filter(Boolean)
      .join(' '),
    words =
      text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .match(/[a-z_][a-z0-9_]{2,}/g) || [];
  return [...new Set(words)].slice(0, 40);
}

function makeSummary(symbol) {
  const doc = (symbol.docstring || '').trim().split('\n').find(Boolean),
  signature = !(doc) ? ((symbol.signature || '').trim()) : undefined;
  if (doc) {
    return doc.slice(0, 240);
  }
  if (signature) {
    return signature.slice(0, 240);
  }
  return `${symbol.kind || 'symbol'} ${symbol.qualified_name || symbol.name}`.slice(0, 240);
}

function stableSymbolId(symbol, fallbackFilePath) {
  return `${symbol.file_path || symbol.file || fallbackFilePath}::${symbol.qualified_name || symbol.name}#${symbol.kind || 'symbol'}`;
}

function collectCallReferences(symbol, callees) {
  if (!Array.isArray(callees) || !Number.isFinite(symbol.start_line) || !Number.isFinite(symbol.end_line)) {
    return [];
  }
  const refs = [];
  for (const call of callees) {
    const line = call.line || 0,
      name = call.full_path || call.callee;
    if (name && line >= symbol.start_line && line <= symbol.end_line && name !== symbol.name) {
      refs.push(name);
    }
  }
  return [...new Set(refs)].slice(0, 80);
}

// PERF: AoS→SoA split (issue #130) — hot fields only, accessed in tight insert loops.
// Do NOT merge cold fields back into this object; keep hot/cold separate so the
// WriteRecords inner loop iterates compact 8-field structs instead of 20-field ones.
// Adding a field here requires updating COLD_FIELDS below and the writeRecords loop.
function normalizeSymbolHot(symbol, fallbackFilePath) {
  return {
    file_path: symbol.file_path || symbol.file || fallbackFilePath,
    name: symbol.name,
    kind: symbol.kind,
    qualified_name: symbol.qualified_name || symbol.name,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    start_byte: symbol.start_byte,
    end_byte: symbol.end_byte,
  };
}

// PERF: Cold fields for symbol — computed/derived data (hashes, JSON blobs, summaries).
// These are accessed only at DB-insert time, NOT in the hot iteration loop.
// Keep this function in sync with normalizeSymbolHot; the hot struct is its first arg.
function normalizeSymbolCold(hot, symbol, fallbackFilePath, context = {}) {
  const signature = symbol.signature || '',
    source = context.content ? sliceByBytes(context.content, hot.start_byte, hot.end_byte) : '',
    decorators = symbol.decorators || extractDecorators(source),
    callReferences = symbol.call_references || collectCallReferences(hot, context.callees || []);
  return {
    signature,
    docstring: symbol.docstring || '',
    body_preview: symbol.body_preview || '',
    language: symbol.language || '',
    parent_name: symbol.parent_name || '',
    stable_symbol_id: symbol.stable_symbol_id || symbol.id || stableSymbolId(hot, fallbackFilePath),
    content_hash: symbol.content_hash || hashText(source || signature || hot.qualified_name),
    summary: symbol.summary || makeSummary(symbol),
    decorators_json: safeJson(decorators),
    keywords_json: safeJson(symbol.keywords || extractKeywords(symbol, source)),
    call_references_json: safeJson(callReferences),
    ecosystem_context: symbol.ecosystem_context || '',
  };
}

function normalizeSymbol(symbol, fallbackFilePath, context = {}) {
  const hot = normalizeSymbolHot(symbol, fallbackFilePath),
    cold = normalizeSymbolCold(hot, symbol, fallbackFilePath, context);
  return { ...hot, ...cold };
}

function _parseRawSymbols(filePath, reg, content) {
  if (!reg.canParseFile(filePath)) {
    return { rawSymbols: [], source: '', callees: [], tree: null };
  }
  let rawSymbols,
    source = content,
  callees = (() => {

    if (content !== undefined) {
      rawSymbols = reg.parseContent(filePath, content);
    } else {
      rawSymbols = reg.parseFile(filePath);
      try {
        source = require('fs').readFileSync(filePath, 'utf-8');
      } catch {
        source = '';
      }
    }
    
  return ([]);
})(),
  tree = (() => {
if (source && typeof reg.extractCalleesFromContent === 'function') {
      try {
        callees = reg.extractCalleesFromContent(filePath, source);
      } catch {}
    }
    
  return (null);
})();try {
    const parseResult = reg.parseTree(filePath, source || content);
    tree = parseResult ? parseResult.tree : null;
  } catch {}
  return { rawSymbols, source, callees, tree };
}

// PERF: AoS→SoA variant (issue #130). Returns { hot: [...], cold: [...] } so the
// WriteRecords hot loop iterates compact 8-field objects while cold data (JSON blobs,
// Hashes) lives in a separate array accessed only at insert time.
function extractSymbolsSplit(filePath, registry, content) {
  const reg = registry || createParserRegistry(),
    { rawSymbols, source, callees, tree } = _parseRawSymbols(filePath, reg, content),
    ctx = { content: source || '', callees, relativeFile: path.basename(filePath) },
    hot = [],
    cold = [];
  for (const raw of rawSymbols) {
    const h = normalizeSymbolHot(raw, filePath);
    hot.push(h);
    cold.push(normalizeSymbolCold(h, raw, filePath, ctx));
  }
  return { hot, cold, tree };
}

function extractSymbolsFromFile(filePath, registry, content) {
  const reg = registry || createParserRegistry(),
    { rawSymbols, source, callees } = _parseRawSymbols(filePath, reg, content),
    ctx = { content: source || '', callees, relativeFile: path.basename(filePath) };
  return rawSymbols.map((symbol) => normalizeSymbol(symbol, filePath, ctx));
}

module.exports = {
  extractSymbolsFromFile,
  extractSymbolsSplit,
  normalizeSymbol,
  normalizeSymbolHot,
  normalizeSymbolCold,
};
