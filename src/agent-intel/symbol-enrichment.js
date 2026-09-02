'use strict';

const { SYMBOL_ENRICHMENT: CFG } = require('../../constants');

function _requireNativeDb(db) {
  if (!db || !db.prepare) {
    return { error: 'Native database connection required' };
  }
  return null;
}

/**
 * Extract intent from symbol data using heuristics.
 * Uses docstring first, then name/signature patterns.
 */
function extractIntent(symbol) {
  if (symbol.docstring && symbol.docstring.trim().length > 5) {
    const firstLine = symbol.docstring
      .trim()
      .split('\n')[0]
      .replace(/\*\/?\s*/g, '')
      .trim();
    if (firstLine.length > 0 && firstLine.length <= CFG.MAX_INTENT_LENGTH) {
      return firstLine;
    }
  }

  const name = symbol.name,
    patterns = [
      { re: /^(?:get|fetch|load|find|query|search)(.+)/i, template: (m) => `Retrieve ${_humanize(m[1])}` },
      { re: /^(?:set|save|store|persist|update|write|put|patch)(.+)/i, template: (m) => `Persist ${_humanize(m[1])}` },
      { re: /^(?:create|add|insert|new|make|build)(.+)/i, template: (m) => `Create ${_humanize(m[1])}` },
      { re: /^(?:delete|remove|destroy|drop)(.+)/i, template: (m) => `Remove ${_humanize(m[1])}` },
      { re: /^(?:validate|check|verify|ensure|assert)(.+)/i, template: (m) => `Validate ${_humanize(m[1])}` },
      { re: /^(?:send|dispatch|emit|publish|notify)(.+)/i, template: (m) => `Send ${_humanize(m[1])}` },
      { re: /^(?:handle|on|process|execute|run|perform)(.+)/i, template: (m) => `Handle ${_humanize(m[1])}` },
      { re: /^(?:is|has|can|should|will)(.+)/i, template: (m) => `Check if ${_humanize(m[1])}` },
      {
        re: /^(?:format|parse|transform|convert|serialize|normalize)(.+)/i,
        template: (m) => `Transform ${_humanize(m[1])}`,
      },
    ];

  for (const { re, template } of patterns) {
    const match = name.match(re);
    if (match) {
      const intent = template(match);
      return intent.length <= CFG.MAX_INTENT_LENGTH ? intent : intent.slice(0, CFG.MAX_INTENT_LENGTH);
    }
  }

  if (symbol.kind === 'class') {
    return `${name} class`;
  }
  if (symbol.kind === 'method') {
    return `${name} method`;
  }
  return `${name} ${symbol.kind || 'symbol'}`;
}

function _humanize(str) {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Extract constraints from comments in body_preview.
 */
function extractConstraints(symbol) {
  const constraints = [],
    body = symbol.body_preview || '',
    docstring = symbol.docstring || '',
    // Extract from line comments
    lineMatches = body.matchAll(/(?:\/\/|#)\s*(?:do not|don't|never|must not|should not|avoid)\s+(.+)/gi),
  docLines = (() => {

    for (const m of lineMatches) {
      const text = m[1].trim().replace(/\s*$/, '');
      if (text.length > 0 && text.length <= CFG.MAX_CONSTRAINT_LENGTH) {
        constraints.push(`Do not ${text.toLowerCase()}`);
      }
    }
  
    // Extract from docstring
    
  return (docstring.split('\n'));
})();for (const line of docLines) {
    const trimmed = line.replace(/\s*\*\s*/g, '').trim(),
      m = trimmed.match(/^(?:do not|don't|never|must not|should not|avoid)\s+(.+)/i);
    if (m) {
      const text = m[1].trim();
      if (text.length > 0 && text.length <= CFG.MAX_CONSTRAINT_LENGTH) {
        constraints.push(`Do not ${text.toLowerCase()}`);
      }
    }
  }

  return [...new Set(constraints)];
}

function _buildBehaviorSummary(symbol) {
  const parts = [];
  if (symbol.kind) {
    parts.push(`${symbol.kind}`);
  }
  if (symbol.signature) {
    parts.push(symbol.signature);
  }
  if (symbol.docstring) {
    const firstLine = symbol.docstring
      .trim()
      .split('\n')[0]
      .replace(/\*\/?\s*/g, '')
      .trim();
    if (firstLine) {
      parts.push(firstLine);
    }
  }
  return parts.join(' — ').slice(0, 500);
}

/**
 * Enrich all symbols in a repo with metadata.
 */
function enrichSymbols(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  const symbols = db
      .prepare(
        `SELECT id, name, kind, signature, docstring, body_preview, file_path, qualified_name
       FROM code_symbols WHERE repo_id = ?`,
      )
      .all(repoId),
    insertMeta = db.prepare(
      `INSERT OR REPLACE INTO symbol_metadata (symbol_id, intent, behavior_summary, constraints, enrichment_source)
     VALUES (?, ?, ?, ?, 'auto')`,
    );

  let enriched = 0,
    skipped = 0;

  {
const tx = db.transaction(() => {
    for (const sym of symbols) {
      const intent = extractIntent(sym),
        constraints = extractConstraints(sym),
        behaviorSummary = _buildBehaviorSummary(sym);

      if (intent.length > 0 || constraints.length > 0 || behaviorSummary.length > 0) {
        insertMeta.run(sym.id, intent, behaviorSummary, JSON.stringify(constraints));
        enriched++;
      } else {
        skipped++;
      }
    }
  });
  tx();

  return {
    total_symbols: symbols.length,
    enriched_count: enriched,
    skipped_count: skipped,
  };
}
}

/**
 * Get metadata for a specific symbol.
 */
function getSymbolMeta(db, symbolId) {
  return db.prepare(`SELECT * FROM symbol_metadata WHERE symbol_id = ?`).get(symbolId) || null;
}

/**
 * Get enriched symbols for a file (used by preflight).
 */
function getFileEnrichment(db, repoId, filePath) {
  const symbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.start_line, s.docstring,
              sm.intent, sm.constraints, sm.behavior_summary
       FROM code_symbols s
       LEFT JOIN symbol_metadata sm ON sm.symbol_id = s.id
       WHERE s.repo_id = ? AND s.file_path = ?`,
    )
    .all(repoId, filePath);

  return symbols.map((sym) => ({
    ...sym,
    constraints: sym.constraints ? JSON.parse(sym.constraints) : [],
  }));
}

module.exports = {
  enrichSymbols,
  getSymbolMeta,
  getFileEnrichment,
  extractIntent,
  extractConstraints,
};
