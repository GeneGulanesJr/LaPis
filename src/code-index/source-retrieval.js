const path = require('path');
const { ensureDb, sqlJson, sqlRaw } = require('../../db');
const { estimateTokens } = require('../../utils');
const { createCodeIndexRepository } = require('./repos');

function sourceSliceFromRow(row) {
  const buf = Buffer.from(row.content, 'utf-8');
  return buf.toString('utf-8', row.start_byte, row.end_byte);
}

function getCodeSource(repoName, filePath, symbolName, repository = null) {
  ensureDb();
  const repo = repository || createCodeIndexRepository(require('../../db'));

  // The symbol index stores absolute file paths; resolve repo-relative inputs
  // (e.g. lib/helper.js, ./x, ../y) against the indexed repo root.
  let resolvedPath = filePath;
  if (!path.isAbsolute(filePath)) {
    const repoRow = repo.findRepoByName(repoName);
    if (!repoRow || !repoRow.path) {
      return { success: false, error: `Repo "${repoName}" not found; cannot resolve relative path "${filePath}"` };
    }
    resolvedPath = path.resolve(repoRow.path, filePath);
  }

  const row = repo.findSymbolSource({ repoName, filePath: resolvedPath, symbolName });
  if (!row) {
    return {
      success: false,
      error: `Symbol "${symbolName}" not found in ${resolvedPath} (repo-relative paths like lib/helper.js are resolved against the repo root)`,
    };
  }

  return {
    success: true,
    repo: repoName,
    file: filePath,
    symbol: row.name,
    kind: row.kind,
    start_line: row.start_line,
    end_line: row.end_line,
    source: sourceSliceFromRow(row),
  };
}

function tokenize(text) {
  return (
    (text || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z_][a-z0-9_]{1,}/g) || []
  );
}

function ensureCodeFts() {
  const ftsCheck = sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='code_symbols_fts'");
  if (!ftsCheck.length) {
    sqlRaw(`CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
      name, kind, signature, docstring, file_path, body_preview, content=code_symbols, content_rowid=id)`);
  }
}

// Centrality scoring for searchCode's rerank step. Only the FTS candidates
// (<= maxResults*4 ids) are ever scored downstream, so the aggregates are
// computed per candidate via chunked IN lookups on idx_cc_callee / idx_cc_caller
// / idx_ci_target. The previous form ran three unbounded GROUP BYs over
// code_calls (~1M rows) plus code_imports and LEFT JOINed every code_symbol in
// scope (up to ~1.4M rows) on EVERY code search (~700ms measured), building a
// Map of millions of scores of which only ~40 were read. The normalization max
// is now the max among candidates, which also keeps the 0.25 centrality weight
// meaningful when an off-scope hub symbol dominates the global maximum.
function centralityBySymbol(symbolIds) {
  const scores = new Map();
  if (!Array.isArray(symbolIds) || symbolIds.length === 0) {
    return { scores, max: 1 };
  }
  const CHUNK = 500;
  const inCalls = new Map(),
    outCalls = new Map(),
    importersByFile = new Map(),
    fileOf = new Map();
  for (let i = 0; i < symbolIds.length; i += CHUNK) {
    const chunk = symbolIds.slice(i, i + CHUNK),
      placeholders = chunk.map(() => '?').join(',');
    for (const row of sqlJson(`SELECT id, file_id FROM code_symbols WHERE id IN (${placeholders})`, chunk)) {
      scores.set(row.id, 0);
      if (row.file_id !== null && row.file_id !== undefined) {
        fileOf.set(row.id, row.file_id);
      }
    }
    for (const row of sqlJson(
      `SELECT callee_symbol_id AS id, COUNT(*) AS count
       FROM code_calls
       WHERE callee_symbol_id IN (${placeholders})
       GROUP BY callee_symbol_id`,
      chunk,
    )) {
      inCalls.set(row.id, row.count);
    }
    for (const row of sqlJson(
      `SELECT caller_symbol_id AS id, COUNT(*) AS count
       FROM code_calls
       WHERE caller_symbol_id IN (${placeholders})
       GROUP BY caller_symbol_id`,
      chunk,
    )) {
      outCalls.set(row.id, row.count);
    }
  }
  const fileIds = [...new Set(fileOf.values())];
  for (let i = 0; i < fileIds.length; i += CHUNK) {
    const chunk = fileIds.slice(i, i + CHUNK),
      placeholders = chunk.map(() => '?').join(',');
    for (const row of sqlJson(
      `SELECT target_file_id AS file_id, COUNT(*) AS count
       FROM code_imports
       WHERE target_file_id IN (${placeholders})
       GROUP BY target_file_id`,
      chunk,
    )) {
      importersByFile.set(row.file_id, row.count);
    }
  }
  let max = 0;
  for (const [id, file_id] of fileOf) {
    const score =
      (inCalls.get(id) || 0) * 2 + (importersByFile.get(file_id) || 0) * 1.5 + (outCalls.get(id) || 0) * 0.25;
    scores.set(id, score);
    if (score > max) {
      max = score;
    }
  }
  return { scores, max: max || 1 };
}

function mapSearchRow(row, i) {
  return {
    rank: i + 1,
    score: row.score,
    repo: row.repo,
    file: row.file,
    symbol: row.symbol_name,
    kind: row.kind,
    line: row.start_line,
    end_line: row.end_line,
    signature: row.signature,
    docstring: row.docstring,
    snippet: row.snippet,
    qualified_name: row.qualified_name,
    language: row.language,
    summary: row.summary || '',
  };
}

function searchCodeLike(query, repoName, kind, maxResults) {
  // Escape the ESCAPE character itself first, then the LIKE wildcards.
  const likeQuery = `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  let sql = `
    SELECT
      s.id, r.name AS repo, s.file_path AS file,
      s.name AS symbol_name, s.kind, s.start_line, s.end_line,
      s.signature, s.docstring, s.body_preview AS snippet,
      s.qualified_name, s.language, s.summary,
      0.0 AS score
    FROM code_symbols s
    JOIN code_repos r ON r.id = s.repo_id
    WHERE (s.name LIKE ? ESCAPE '\\' OR s.qualified_name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\')
  `;
  const params = [likeQuery, likeQuery, likeQuery, likeQuery];

  if (repoName) {
    sql += ' AND r.name = ?';
    params.push(repoName);
  }
  if (kind) {
    sql += ' AND s.kind = ?';
    params.push(kind);
  }

  sql += ' LIMIT ?';
  params.push(maxResults);

  const rows = sqlJson(sql, params);
  return {
    query,
    results: rows.map(mapSearchRow),
    total: rows.length,
    strategy: 'like',
  };
}

function searchCode(query, repoName, kind, maxResults) {
  ensureDb();

  try {
    ensureCodeFts();
  } catch {
    return searchCodeLike(query, repoName, kind, maxResults);
  }

  const ftsQuery = tokenize(query)
    .map((term) => `${term}*`)
    .join(' OR ');
  if (!ftsQuery) {
    return searchCodeLike(query, repoName, kind, maxResults);
  }

  let sql = `
    SELECT
      s.id, r.name AS repo, s.file_path AS file,
      s.name AS symbol_name, s.kind, s.start_line, s.end_line,
      s.signature, s.docstring, s.body_preview AS snippet,
      s.qualified_name, s.language, s.summary,
      bm25(code_symbols_fts) AS bm25_score
    FROM code_symbols_fts
    JOIN code_symbols s ON s.id = code_symbols_fts.rowid
    JOIN code_repos r ON r.id = s.repo_id
    WHERE code_symbols_fts MATCH ?
  `;
  const params = [ftsQuery];

  if (repoName) {
    sql += ' AND r.name = ?';
    params.push(repoName);
  }
  if (kind) {
    sql += ' AND s.kind = ?';
    params.push(kind);
  }

  sql += ' ORDER BY bm25(code_symbols_fts) LIMIT ?';
  params.push(Math.max(maxResults * 4, maxResults));

  let rows;
  try {
    rows = sqlJson(sql, params);
  } catch {
    return searchCodeLike(query, repoName, kind, maxResults);
  }
  const { scores, max } = centralityBySymbol(rows.map((row) => row.id));
  const reranked = rows
    .map((row) => {
      const bm25Raw = Math.max(0, -Number(row.bm25_score || 0));
      const bm25Norm = bm25Raw / (1 + bm25Raw);
      const centralityNorm = (scores.get(row.id) || 0) / max;
      return { ...row, score: 0.75 * bm25Norm + 0.25 * centralityNorm };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  const results = reranked.map(mapSearchRow);
  return { query, results, total: results.length, strategy: 'bm25-centrality' };
}

function rankedContext(query, repoName, options = {}) {
  ensureDb();
  const tokenBudget = Math.max(200, Number(options.tokenBudget || options.token_budget || 4000));
  const maxResults = Math.max(1, Number(options.maxResults || options.max_results || 20));
  const search = searchCode(query, repoName || null, options.kind || null, maxResults);
  const items = [];
  let totalTokens = 0;
  let considered = 0;

  for (const result of search.results || []) {
    considered++;
    const source = getCodeSource(result.repo, result.file, result.symbol);
    if (!source.success) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    const text = [result.signature, result.summary, source.source].filter(Boolean).join('\n');
    const tokens = estimateTokens(text);
    if (items.length > 0 && totalTokens + tokens > tokenBudget) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    items.push({
      repo: result.repo,
      file: result.file,
      symbol: result.symbol,
      qualified_name: result.qualified_name,
      kind: result.kind,
      score: result.score,
      start_line: result.line,
      end_line: result.end_line,
      signature: result.signature,
      summary: result.summary,
      tokens,
      source: source.source,
    });
    totalTokens += tokens;
    if (totalTokens >= tokenBudget) {
      break;
    }
  }

  const response = {
    query,
    repo: repoName || null,
    context_items: items,
    total_tokens: totalTokens,
    budget_tokens: tokenBudget,
    items_included: items.length,
    items_considered: considered,
    search_strategy: search.strategy,
  };
  if (items.length === 0) {
    response.negative_evidence = {
      verdict: 'no_implementation_found',
      scanned_results: (search.results || []).length,
      best_match_score: search.results && search.results[0] ? search.results[0].score : 0,
    };
    response.warning = `No implementation found for '${query.slice(0, 80)}'.`;
  }
  return response;
}

function listCodeRepos(repository = null) {
  ensureDb();
  const repo = repository || createCodeIndexRepository(require('../../db'));
  const repos = repo.listRepos();
  return { repos, total: repos.length };
}

function removeCodeRepo(name, repository = null) {
  ensureDb();
  const repo = repository || createCodeIndexRepository(require('../../db'));
  if (!repo.removeRepoByName(name)) {
    return { error: `Repo not found: ${name}` };
  }
  return { success: true, repo: name, removed: true };
}

module.exports = {
  sourceSliceFromRow,
  getCodeSource,
  rankedContext,
  searchCodeLike,
  searchCode,
  listCodeRepos,
  removeCodeRepo,
};
