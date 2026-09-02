const { indexRepository, reindexRepository, getCodeRepoHealth } = require('../../code-index/incremental-indexer'), { getDependencyCycles } = require('../../code-analysis/graph'), { getDb } = require('../../../db');



// Compute real dependency cycles; degrade gracefully to a zero-value so a
// Graph-build failure never 500s the whole summary/graph endpoint.
function safeDependencyCycles(db, repoId) {
  try {
    return getDependencyCycles(db, repoId);
  } catch {
    return { cycles: [], total_circular_files: 0 };
  }
}

function indexRepo(deps) {
  return async (req, res, { body }) => {
    const { path: repoPath, name } = body || {};
    if (!repoPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'path is required' }));
    }
    const path = require('path'),
      repoName = name || path.basename(repoPath),
      result = await indexRepository({ db: getDb(), args: {} }, repoPath, repoName);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  };
}

function reindexRepo(deps) {
  return async (req, res, { body }) => {
    const { repo, mode } = body || {};
    if (!repo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo is required' }));
    }
    const result = await reindexRepository({ db: getDb(), args: {} }, repo, mode || 'incremental');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  };
}

function codeRepoHealthHandler(deps) {
  return async (req, res, { params }) => {
    const { repo } = params;
    if (!repo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo is required' }));
    }
    const result = await getCodeRepoHealth({ db: getDb(), args: {} }, repo);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  };
}

function detectModule(filePath) {
  const parts = filePath.split('/');
  if (parts[0] === 'packages' && parts.length > 1) {
    return parts[1];
  }
  if (parts[0] === 'apps' && parts.length > 1) {
    return parts[1];
  }
  if (parts[0] === 'libs' && parts.length > 1) {
    return parts[1];
  }
  if (parts[0] === 'src' && parts.length > 1) {
    return parts[1];
  }
  return parts[0] || 'root';
}

function codeRepoSummary(deps) {
  return async (req, res, { params }) => {
    const { repo } = params;
    if (!repo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo is required' }));
    }
    const db = getDb(),
      repoRow = db.prepare('SELECT id, file_count, symbol_count FROM code_repos WHERE name = ?').get(repo);
    if (!repoRow) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo not found' }));
    }

    // Edge count
    const edgeRow = db
        .prepare('SELECT COUNT(*) as count FROM code_imports WHERE repo_id = ? AND target_file_id IS NOT NULL')
        .get(repoRow.id),
      // Module grouping
      fileRows = db.prepare('SELECT path FROM code_files WHERE repo_id = ?').all(repoRow.id),
      modules = new Map();
    for (const f of fileRows) {
      const mod = detectModule(f.path);
      modules.set(mod, (modules.get(mod) || 0) + 1);
    }
    const moduleList = [...modules.entries()]
        .map(([name, fileCount]) => ({ name, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount),
      // Entry points: files with most importers (afferent coupling)
      entryRows = db
        .prepare(`
      SELECT cf.path, COUNT(DISTINCT ci.source_file_id) as importer_count
      FROM code_imports ci
      JOIN code_files cf ON cf.id = ci.target_file_id
      WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
      GROUP BY ci.target_file_id
      ORDER BY importer_count DESC
      LIMIT 5
    `)
        .all(repoRow.id),
      entryPoints = entryRows.map((r) => r.path.split('/').pop()),
      cyc = safeDependencyCycles(db, repoRow.id);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        files: repoRow.file_count,
        symbols: repoRow.symbol_count,
        edges: edgeRow.count,
        modules: moduleList,
        entryPoints,
        cycles: { count: cyc.cycles.length, paths: cyc.cycles.map((c) => c.files) },
      }),
    );
  };
}

function codeRepoGraph(deps) {
  return async (req, res, { params }) => {
    const { repo } = params;
    if (!repo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo is required' }));
    }
    const db = getDb(),
      repoRow = db.prepare('SELECT id FROM code_repos WHERE name = ?').get(repo);
    if (!repoRow) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo not found' }));
    }

    // Top 50 files by symbol count
    const fileRows = db
        .prepare(`
      SELECT cf.id, cf.path, COUNT(cs.id) as symbol_count
      FROM code_files cf
      LEFT JOIN code_symbols cs ON cs.file_id = cf.id
      WHERE cf.repo_id = ?
      GROUP BY cf.id
      ORDER BY symbol_count DESC
      LIMIT 50
    `)
        .all(repoRow.id),
      fileIds = new Set(fileRows.map((f) => f.id)),
      nodes = fileRows.map((f) => ({
        id: f.path.split('/').pop(),
        fullPath: f.path,
        module: detectModule(f.path),
        symbols: f.symbol_count,
        importance: Math.min(1, f.symbol_count / 50),
      })),
      // Import edges between top files
      nodePaths = new Set(nodes.map((n) => n.fullPath));
    let edges = [];
    if (fileIds.size > 0) {
      const edgeRows = db
        .prepare(`
        SELECT sf.path as from_path, tf.path as to_path
        FROM code_imports ci
        JOIN code_files sf ON sf.id = ci.source_file_id
        JOIN code_files tf ON tf.id = ci.target_file_id
        WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
      `)
        .all(repoRow.id);
      edges = edgeRows
        .filter((e) => nodePaths.has(e.from_path) && nodePaths.has(e.to_path))
        .map((e) => ({
          from: e.from_path.split('/').pop(),
          to: e.to_path.split('/').pop(),
          kind: 'import',
        }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    const cyc = safeDependencyCycles(db, repoRow.id);
    res.end(
      JSON.stringify({
        nodes,
        edges,
        cycles: cyc.cycles.map((c) => ({ files: c.files, edges: c.edges })),
      }),
    );
  };
}

function codeRepoHotspots(deps) {
  return async (req, res, { params }) => {
    const { repo } = params;
    if (!repo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo is required' }));
    }
    const db = getDb(),
      repoRow = db.prepare('SELECT id FROM code_repos WHERE name = ?').get(repo);
    if (!repoRow) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'repo not found' }));
    }

    const fileRows = db
        .prepare(`
      SELECT cf.path, SUM(sc.cyclomatic) as complexity, COUNT(cs.id) as symbols
      FROM code_files cf
      JOIN code_symbols cs ON cs.file_id = cf.id
      JOIN symbol_complexity sc ON sc.symbol_id = cs.id
      WHERE cf.repo_id = ?
      GROUP BY cf.id
      ORDER BY complexity DESC
      LIMIT 20
    `)
        .all(repoRow.id),
      files = fileRows.map((f) => ({
        path: f.path,
        module: detectModule(f.path),
        complexity: f.complexity || 0,
        symbols: f.symbols || 0,
      }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files }));
  };
}

module.exports = { indexRepo, reindexRepo, codeRepoHealthHandler, codeRepoSummary, codeRepoGraph, codeRepoHotspots };
