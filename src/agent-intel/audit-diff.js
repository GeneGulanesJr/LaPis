'use strict';

const path = require('path');
const { AUDIT_DIFF: CFG } = require('../../constants');

function _requireNativeDb(db) {
  if (!db || !db.prepare) {
    return { error: 'Native database connection required' };
  }
  return null;
}

/**
 * Audit changed files for violations.
 */
function auditDiff(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db),
  { files = [], task = '' } = !(guard) ? (opts) : undefined,
  violations = !(guard) && !(files.length === 0) ? ([]) : undefined,
  weights = !(guard) && !(files.length === 0) ? (CFG.RISK_WEIGHTS) : undefined;
  if (guard) {
    return guard;
  }

  if (files.length === 0) {
    return { violations: [], risk: 'low', files_checked: 0 };
  }

  let riskScore = 0;

  for (const filePath of files.slice(0, CFG.MAX_FILES)) {
    const symbols = db
      .prepare(
        `SELECT id, name, kind, signature, body_preview, file_path FROM code_symbols WHERE repo_id = ? AND file_path = ?`,
      )
      .all(repoId, filePath);

    for (const sym of symbols) {
      const dupes = _checkDuplicateCreation(db, repoId, sym),
      constraint = (() => {

        if (dupes) {
          violations.push(dupes);
          riskScore += weights.duplicate;
        }
  
        
  return (_checkConstraintViolation(db, sym));
})();if (constraint) {
        violations.push(constraint);
        riskScore += weights.constraint;
      }

      const untested = _checkUntestedPublic(db, repoId, sym),
      hotPath = (() => {

        if (untested) {
          violations.push(untested);
          riskScore += weights.untested;
        }
  
        
  return (_checkHotPath(db, repoId, sym));
})();if (hotPath) {
        violations.push(hotPath);
        riskScore += weights.hot_path;
      }
    }
  }

  if (task) {
    const ignored = _checkExistingServiceIgnored(db, repoId, task, files);
    if (ignored) {
      violations.push(ignored);
      riskScore += weights.ignored_service;
    }
  }

  const risk = _scoreToRisk(riskScore);

  _persistAudit(db, repoId, task, files, violations, risk);

  return {
    violations,
    risk,
    files_checked: files.length,
    risk_score: Math.round(riskScore * 100) / 100,
  };
}

function _checkDuplicateCreation(db, repoId, sym) {
  const nameParts = sym.name
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (nameParts.length < 2) {
    return null;
  }

  const similar = db
    .prepare(
      `SELECT name, file_path FROM code_symbols
       WHERE repo_id = ? AND file_path != ? AND name != ?
       AND (name LIKE ? OR name LIKE ?)
       LIMIT 3`,
    )
    .all(repoId, sym.file_path, sym.name, `%${nameParts.join('%')}%`, `%${nameParts[nameParts.length - 1]}%`);

  if (similar.length === 0) {
    return null;
  }

  return {
    type: 'duplicate_creation',
    severity: 'warning',
    message: `New symbol "${sym.name}" may duplicate existing: ${similar.map((s) => `${s.name} in ${s.file_path}`).join(', ')}`,
    file: sym.file_path,
    symbol: sym.name,
  };
}

function _checkConstraintViolation(db, sym) {
  try {
    const meta = db.prepare(`SELECT constraints FROM symbol_metadata WHERE symbol_id = ?`).get(sym.id),
    constraints = !(!meta || !meta.constraints) ? (JSON.parse(meta.constraints)) : undefined;
    if (!meta || !meta.constraints) {
      return null;
    }
    if (constraints.length === 0) {
      return null;
    }

    return {
      type: 'constraint_violation',
      severity: 'info',
      message: `Symbol "${sym.name}" has constraints: ${constraints.join('; ')}`,
      file: sym.file_path,
      symbol: sym.name,
    };
  } catch {
    return null;
  }
}

function _checkUntestedPublic(db, repoId, sym) {
  if (sym.kind === 'private' || sym.kind === 'field') {
    return null;
  }

  const testCallers = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM code_calls cc
       JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
       JOIN code_files cf ON cf.id = cs.file_id
       WHERE cc.callee_symbol_id = ? AND (cf.path LIKE '%test%' OR cf.path LIKE '%spec%')`,
    )
    .get(sym.id);

  if (testCallers && testCallers.cnt > 0) {
    return null;
  }

  return {
    type: 'untested_public_api',
    severity: 'info',
    message: `Public symbol "${sym.name}" in ${sym.file_path} has no test callers`,
    file: sym.file_path,
    symbol: sym.name,
  };
}

function _checkHotPath(db, repoId, sym) {
  // First check runtime hotness data if available
  try {
    const runtimeIngest = require('./runtime-ingest'),
      hotSymbols = runtimeIngest.getHotSymbols(db, repoId, 100),
      // Normalize paths for comparison - get basename and check for matches
      symFileName = sym.file_path ? path.basename(sym.file_path) : '',
      hotMatch = hotSymbols.find((s) => {
        if (!s.file_path) {
          return false;
        }
        // Try exact match first
        if (s.file_path === sym.file_path) {
          return true;
        }
        // Then try basename match for cross-platform compatibility
        const runtimeFileName = path.basename(s.file_path);
        return runtimeFileName === symFileName && s.function_name === sym.name;
      });

    if (hotMatch) {
      return {
        type: 'hot_path_modified',
        severity: 'warning',
        message: `Hot runtime path (${hotMatch.hit_count} hits) — prefer minimal diffs and add tests`,
        file: sym.file_path,
        symbol: sym.name,
        runtime_data: {
          traffic: hotMatch.traffic,
          hit_count: hotMatch.hit_count,
        },
      };
    }
  } catch {
    // Runtime data not available — fall back to caller count
  }

  // Fallback: check caller count as proxy for hot path
  const callers = db
    .prepare(
      `SELECT COUNT(DISTINCT caller_symbol_id) as cnt FROM code_calls
       WHERE callee_symbol_id = ? AND repo_id = ?`,
    )
    .get(sym.id, repoId);

  if (callers && callers.cnt >= 5) {
    return {
      type: 'hot_path_modified',
      severity: 'warning',
      message: `Symbol "${sym.name}" has ${callers.cnt} callers — treat as hot path`,
      file: sym.file_path,
      symbol: sym.name,
    };
  }
  return null;
}

function _checkExistingServiceIgnored(db, repoId, task, changedFiles) {
  const terms = task
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) {
    return null;
  }

  const changedSet = new Set(changedFiles),
    conditions = terms.map(() => `name LIKE ?`).join(' OR '),
    params = terms.map((t) => `%${t}%`),
    existing = db
      .prepare(
        `SELECT name, file_path FROM code_symbols
       WHERE repo_id = ? AND (${conditions})
       LIMIT 5`,
      )
      .all(repoId, ...params),
    ignored = existing.filter((s) => !changedSet.has(s.file_path));
  if (ignored.length === 0) {
    return null;
  }

  return {
    type: 'existing_service_ignored',
    severity: 'warning',
    message: `Task "${task}" may relate to existing code not modified: ${ignored.map((s) => `${s.name} in ${s.file_path}`).join(', ')}`,
  };
}

function _scoreToRisk(score) {
  if (score >= CFG.RISK_LEVELS.HIGH) {
    return 'high';
  }
  if (score >= CFG.RISK_LEVELS.MEDIUM) {
    return 'medium';
  }
  return 'low';
}

function _persistAudit(db, repoId, task, files, violations, risk) {
  try {
    db.prepare(`INSERT INTO audit_runs (repo_id, task, files_changed, violations, risk) VALUES (?, ?, ?, ?, ?)`).run(
      repoId,
      task,
      JSON.stringify(files),
      JSON.stringify(violations),
      risk,
    );
  } catch {
    // Table may not exist yet — graceful
  }
}

module.exports = { auditDiff };
