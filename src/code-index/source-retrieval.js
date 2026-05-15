const { ensureDb, sqlJson, sqlRaw } = require('../../db');
const { createCodeIndexRepository } = require('./repos');

function sourceSliceFromRow(row) {
  const buf = Buffer.from(row.content, 'utf-8');
  return buf.toString('utf-8', row.start_byte, row.end_byte);
}

function getCodeSource(repoName, filePath, symbolName, repository = null) {
  ensureDb();
  const repo = repository || createCodeIndexRepository(require('../../db'));
  const row = repo.findSymbolSource({ repoName, filePath, symbolName });
  if (!row) {
    return { success: false, error: 'Symbol not found' };
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

function searchCodeLike(query, repoName, kind, maxResults) {
  const likeQuery = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  let sql = `
    SELECT
      s.id, r.name AS repo, s.file_path AS file,
      s.name AS symbol_name, s.kind, s.start_line, s.end_line,
      s.signature, s.docstring, s.body_preview AS snippet,
      s.qualified_name, s.language,
      0.0 AS score
    FROM code_symbols s
    JOIN code_repos r ON r.id = s.repo_id
    WHERE s.name LIKE ?
  `;
  const params = [likeQuery];

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
    results: rows.map((row, i) => ({
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
    })),
  };
}

function searchCode(query, repoName, kind, maxResults) {
  ensureDb();

  try {
    const ftsCheck = sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='code_symbols_fts'");
    if (!ftsCheck.length) {
      try {
        sqlRaw(`CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
          name, kind, signature, docstring, file_path, body_preview, content=code_symbols, content_rowid=id)`);
      } catch (_) {
        return searchCodeLike(query, repoName, kind, maxResults);
      }
    }
  } catch (_) {
    return searchCodeLike(query, repoName, kind, maxResults);
  }

  const ftsQuery = query.replace(/"/g, "''").split(/\s+/).join(' OR ');

  let sql = `
    SELECT
      s.id, r.name AS repo, s.file_path AS file,
      s.name AS symbol_name, s.kind, s.start_line, s.end_line,
      s.signature, s.docstring, s.body_preview AS snippet,
      s.qualified_name, s.language,
      bm25(code_symbols_fts) AS score
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
  params.push(maxResults);

  const rows = sqlJson(sql, params);
  const results = rows.map((row, i) => ({
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
    language: row.language,
  }));

  return { query, results, total: results.length };
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

module.exports = { sourceSliceFromRow, getCodeSource, searchCodeLike, searchCode, listCodeRepos, removeCodeRepo };
