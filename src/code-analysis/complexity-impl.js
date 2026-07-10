// Cyclomatic complexity computation and file outline extraction.
const path = require('path');

// oxlint-disable-next-line no-unused-vars
const { codeParser, _requireNativeDb, COMPLEXITY } = require('./shared-deps');

// Escape SQL LIKE wildcard characters.
function _likeEscape(str) {
  return str.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

// PERF(issue #133): Decision-point patterns hoisted to module scope. Previously
// this 10-element RegExp array was re-allocated once per symbol inside
// buildComplexity, i.e. 10N regex allocations for N functions in the repo. The
// patterns carry the /g flag and lastIndex is reset before each use below, so
// reuse across iterations is safe (single-threaded synchronous scan).
// Do NOT move this array back into the per-symbol loop body.
const DECISION_PATTERNS = [
  // (?<!else\s+) excludes the `if` token in `else if` (with any whitespace —
  // space, tab, newline, or multiple) so it's counted once by the dedicated
  // /else\s+if/ pattern below, not double-counted.
  /(?<!else\s+)if\b/g,
  /else\s+if\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bdo\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /\&\&/g,
  /\|\|/g,
  /\?\?/g,
];
// PERF(issue #133): Ternary pattern hoisted alongside DECISION_PATTERNS for the
// same reason (was re-created per symbol). lastIndex is reset before its
// .exec() loop below.
const TERNARY_RE = /\?(?:\s*[^.:])/g;

function normalizeRepoPath(filePath, repoRoot = null) {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .replace(/^\.\//, '');
  if (!repoRoot || !path.isAbsolute(normalized)) {
    return normalized;
  }
  const relative = path.relative(repoRoot, normalized).replace(/\\/g, '/');
  return relative && !relative.startsWith('..') && relative !== '.' ? relative : normalized;
}

function getRepoRoot(db, repoId) {
  const row = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
  return row?.path ? path.resolve(row.path) : null;
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
    // Note: optional chaining (?.) is NOT a decision point per spec
    for (const pattern of DECISION_PATTERNS) {
      pattern.lastIndex = 0;
      const m = body.match(pattern);
      if (m) {
        cyclomatic += m.length;
      }
    }
    // Ternary (?:) — count only if not followed by . (to exclude ?.)
    TERNARY_RE.lastIndex = 0;
    while (TERNARY_RE.exec(body) !== null) {
      cyclomatic++;
    }

    // PERF(issue #133): CharCode fast-path — reduces branch evaluations from 6+ per byte to
    // 1 for the common case (plain code, not in string/template). Uses integer charCodeAt
    // Instead of string boxing. body.substring() replaced with charCodeAt to avoid allocation.
    // Do NOT replace charCode checks with string comparisons; the integer path is the
    // Performance-critical fast path. Template depth tracking logic is preserved as-is.
    let maxDepth = 0,
      currentDepth = 0;
    let inString = false,
      stringCharCode = 0,
      templateDepth = 0;
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);

      if (inString) {
        if (code === stringCharCode && (i === 0 || body.charCodeAt(i - 1) !== 92)) {
          inString = false;
        }
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (templateDepth === 0) {
        if (code !== 34 && code !== 39 && code !== 96 && code !== 123 && code !== 125) {
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (code === 34 || code === 39) {
          inString = true;
          stringCharCode = code;
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (code === 96) {
          templateDepth++;
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (code === 123) {
          currentDepth++;
          if (currentDepth > maxDepth) {
            maxDepth = currentDepth;
          }
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (currentDepth > 0) {
          currentDepth--;
        }
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (code === 96) {
        templateDepth++;
        // oxlint-disable-next-line no-continue
        continue;
      }
      if (code === 123) {
        currentDepth++;
        if (currentDepth > maxDepth) {
          maxDepth = currentDepth;
        }
      } else if (code === 125) {
        if (currentDepth > 0) {
          currentDepth--;
        }
      }
    }

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
  const repoRoot = getRepoRoot(db, repoId);
  const normalizedPath = normalizeRepoPath(filePath, repoRoot);
  const allFiles = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ? ORDER BY path').all(repoId);
  const filesWithRelativePath = allFiles.map((row) => ({
    ...row,
    relative_path: normalizeRepoPath(row.path, repoRoot),
  }));
  const directoryMatches = filesWithRelativePath
    .filter((row) => row.relative_path.startsWith(`${normalizedPath}/`))
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  if (directoryMatches.length > 1) {
    const visibleMatches = directoryMatches.slice(0, 25);
    return {
      file: filePath,
      directory: true,
      files: visibleMatches.map((row) => row.relative_path),
      total_files: directoryMatches.length,
      truncated: directoryMatches.length > visibleMatches.length,
      message: `Path "${filePath}" matches ${directoryMatches.length} files. Refine --file to a specific file for symbols.`,
    };
  }

  const exactFile =
    filesWithRelativePath.find((row) => row.path === filePath || row.relative_path === normalizedPath) || null;
  const suffixFile = exactFile
    ? null
    : filesWithRelativePath.find((row) => row.relative_path.endsWith(`/${normalizedPath}`));
  const fileRow = exactFile || suffixFile;
  if (!fileRow) {
    // Suggest available files that partially match
    const basename = normalizedPath.split('/').pop();
    const suggestions = filesWithRelativePath
      .filter((row) => row.relative_path.includes(basename))
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
      .slice(0, 20);
    const totalFiles = allFiles.length;
    if (suggestions.length) {
      return {
        file: filePath,
        classes: [],
        standalone: [],
        not_found: true,
        message: `File not found: "${filePath}". Did you mean one of these?`,
        suggestions: suggestions.map((s) => s.relative_path),
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
    WHERE cs.repo_id = ? AND (cs.file_id = ? OR cs.file_path = ? OR cs.file_path LIKE ? ESCAPE '!')
    ORDER BY cs.start_line
  `)
    .all(repoId, fileRow.id, fileRow.path, `%/${_likeEscape(fileRow.path)}`);

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

  return { file: fileRow.relative_path || fileRow.path, classes, standalone };
}

module.exports = { buildComplexity, getComplexity, getFileOutline };
