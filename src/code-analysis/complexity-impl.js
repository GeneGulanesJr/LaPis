// Cyclomatic complexity computation and file outline extraction.

// oxlint-disable-next-line no-unused-vars
const { codeParser, _requireNativeDb, COMPLEXITY, computeNestingDepth } = require('./shared-deps');

// Escape SQL LIKE wildcard characters.
function _likeEscape(str) {
  return str.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

function buildComplexity(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  db.prepare('DELETE FROM symbol_complexity WHERE symbol_id IN (SELECT id FROM code_symbols WHERE repo_id = ?)').run(
    repoId,
  );

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_complexity (symbol_id, cyclomatic, nesting_depth, param_count, lines_of_code, assessment) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const symbols = db
    .prepare(`
    SELECT cs.id, cs.name, cs.start_byte, cs.end_byte, cs.start_line, cs.end_line, cs.signature, cf.content as file_content
    FROM code_symbols cs JOIN code_files cf ON cf.id = cs.file_id WHERE cs.repo_id = ? AND cs.kind IN ('function', 'method')
  `)
    .all(repoId);

  let count = 0;
  for (const sym of symbols) {
    if (!sym.file_content || sym.end_byte <= sym.start_byte) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    const body = Buffer.from(sym.file_content, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
    if (!body) {
      // oxlint-disable-next-line no-continue
      continue;
    }

    let cyclomatic = 1;
    const decisionPatterns = [
      /if\b/g,
      /else\s+if\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\&\&/g,
      /\|\|/g,
      /\?\?/g,
    ];
    // Note: optional chaining (?.) is NOT a decision point per spec
    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      const m = body.match(pattern);
      if (m) {
        cyclomatic += m.length;
      }
    }
    // Ternary (?:) — count only if not followed by . (to exclude ?.)
    const ternaryRe = /\?(?:\s*[^.:])/g;
    let __ternaryMatch;
    while ((_ternaryMatch = ternaryRe.exec(body)) !== null) {
      cyclomatic++;
    }

    const maxDepth = computeNestingDepth(body);

    const sigMatch = sym.signature ? sym.signature.match(/\(([^)]*)\)/) : null;
    const paramCount = sigMatch ? sigMatch[1].split(',').filter((p) => p.trim()).length : 0;
    const lines = body.split('\n');
    const codeLines = lines.filter((l) => l.trim() && !l.trim().startsWith('//')).length;
    let assessment = 'high';
    if (cyclomatic <= COMPLEXITY.LOW_THRESHOLD) {
      assessment = 'low';
    } else if (cyclomatic <= COMPLEXITY.MEDIUM_THRESHOLD) {
      assessment = 'medium';
    }

    insertStmt.run(sym.id, cyclomatic, maxDepth, paramCount, codeLines, assessment);
    count++;
  }

  return { success: true, symbols: count };
}

function getComplexity(db, repoId, symbolId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  if (symbolId) {
    const row = db
      .prepare(
        'SELECT sc.*, cs.name, cs.file_path FROM symbol_complexity sc JOIN code_symbols cs ON cs.id = sc.symbol_id WHERE sc.symbol_id = ?',
      )
      .get(symbolId);
    if (!row) {
      return { error: 'Complexity not computed' };
    }
    return row;
  }
  return db
    .prepare(
      'SELECT sc.*, cs.name, cs.file_path FROM symbol_complexity sc JOIN code_symbols cs ON cs.id = sc.symbol_id WHERE cs.repo_id = ? ORDER BY sc.cyclomatic DESC',
    )
    .all(repoId);
}

// ══════════════════════════════════════════════════════════
// FILE OUTLINE
// ══════════════════════════════════════════════════════════

function getFileOutline(db, repoId, filePath) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const fileRow = db
    .prepare("SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ? ESCAPE '!'")
    .get(repoId, `%${_likeEscape(filePath)}%`);
  if (!fileRow) {
    // Suggest available files that partially match
    const suggestions = db
      .prepare("SELECT path FROM code_files WHERE repo_id = ? AND path LIKE ? ESCAPE '!' LIMIT 20")
      .all(repoId, `%${_likeEscape(filePath.split('/').pop())}%`);
    const totalFiles = db.prepare('SELECT COUNT(*) as cnt FROM code_files WHERE repo_id = ?').get(repoId).cnt;
    if (suggestions.length) {
      return {
        file: filePath,
        classes: [],
        standalone: [],
        not_found: true,
        message: `File not found: "${filePath}". Did you mean one of these?`,
        suggestions: suggestions.map((s) => s.path),
        total_files_in_repo: totalFiles,
        hint: `Files are resolved relative to the repo root. List all files with: memory-store.js outline --repo <repo> (no --file)`,
      };
    }
    return {
      file: filePath,
      classes: [],
      standalone: [],
      not_found: true,
      message: `File not found: "${filePath}" in repo. ${totalFiles} files indexed.`,
      total_files_in_repo: totalFiles,
      hint: `Use --file with a path relative to the repo root.`,
    };
  }

  const symbols = db
    .prepare(`
    SELECT cs.id, cs.name, cs.kind, cs.start_line, cs.end_line, cs.signature, cs.qualified_name, cs.parent_name,
           sc.cyclomatic, sc.assessment
    FROM code_symbols cs LEFT JOIN symbol_complexity sc ON sc.symbol_id = cs.id
    WHERE cs.repo_id = ? AND cs.file_path LIKE ? ESCAPE '!' ORDER BY cs.start_line
  `)
    .all(repoId, `%${_likeEscape(filePath)}%`);

  const classes = [];
  const standalone = [];
  for (const sym of symbols) {
    if (sym.parent_name) {
      let cls = classes.find((c) => c.name === sym.parent_name);
      if (!cls) {
        cls = { name: sym.parent_name, methods: [] };
        classes.push(cls);
      }
      cls.methods.push(sym);
    } else {
      standalone.push(sym);
    }
  }

  return { file: filePath, classes, standalone };
}


module.exports = { buildComplexity, getComplexity, getFileOutline };
