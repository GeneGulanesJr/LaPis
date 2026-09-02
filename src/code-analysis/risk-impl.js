const { execFileSync } = require('child_process');
// PR risk profiling and untested symbol detection.

const {
  path,
  _requireNativeDb,
  PR_RISK,
  UNDETECTED_CONFIDENCE,
  COMPLEXITY /* oxlint-disable-line no-unused-vars */,
  HOTSPOT_THRESHOLDS /* oxlint-disable-line no-unused-vars */,
} = require('./shared-deps');
const { getBlastRadius } = require('./import-graph-impl'),
  GIT_REF_RE = /^[A-Za-z0-9._^~/-]+$/;

function isValidGitRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && GIT_REF_RE.test(ref);
}

function gitDiffOutput(repoPath, base, branch, stat = false) {
  if (!isValidGitRef(base) || !isValidGitRef(branch)) {
    return '';
  }
  const range = `${base}...${branch}`,
    args = stat ? ['-C', repoPath, 'diff', '--stat', range] : ['-C', repoPath, 'diff', '--name-only', range];
  return execFileSync('git', args, {
    encoding: 'utf-8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function getUntestedSymbols(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const { minConfidence = 0.5, includePrivate = false } = opts,
    // 1. Identify test files
    allFiles = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ?').all(repoId),
    testFileIds = new Set(),
  testImportedFiles = (() => {

    for (const f of allFiles) {
      if (
        f.path.includes('.test.') ||
        f.path.includes('.spec.') ||
        f.path.includes('/test/') ||
        f.path.includes('/__tests__/')
      ) {
        testFileIds.add(f.id);
      }
    }
  
    // 2. Trace import graph from test files → production files (batch)
    
  return (new Set());
})();if (testFileIds.size > 0) {
    const testIdList = [...testFileIds],
      batchImports = db
        .prepare(
          `SELECT target_file_id FROM code_imports WHERE source_file_id IN (${testIdList.map(() => '?').join(',')}) AND target_file_id IS NOT NULL`,
        )
        .all(...testIdList);
    for (const imp of batchImports) {
      testImportedFiles.add(imp.target_file_id);
    }
  }

  // 3. Trace call graph from test functions → production symbols (batch)
  const testedSymbols = new Set(),
    indirectlyTested = new Set();

  if (testFileIds.size > 0) {
    const testSymbols = db
      .prepare(
        `SELECT id FROM code_symbols WHERE file_id IN (${[...testFileIds].map(() => '?').join(',')}) AND repo_id = ?`,
      )
      .all(...[...testFileIds, repoId]);

    if (testSymbols.length > 0) {
      const testSymIds = testSymbols.map((ts) => ts.id),
        // Batch: direct callees for all test symbols at once
        directCallees = db
          .prepare(
            `SELECT caller_symbol_id, callee_symbol_id FROM code_calls WHERE caller_symbol_id IN (${testSymIds.map(() => '?').join(',')}) AND callee_symbol_id IS NOT NULL`,
          )
          .all(...testSymIds),
      directCalleeIds = (() => {

  
        for (const dc of directCallees) {
          testedSymbols.add(dc.callee_symbol_id);
        }
  
        // Batch: indirect callees (level 2) for all direct callee IDs at once
        
  return ([...testedSymbols]);
})();if (directCalleeIds.length > 0) {
        const indirectCallees = db
          .prepare(
            `SELECT caller_symbol_id, callee_symbol_id FROM code_calls WHERE caller_symbol_id IN (${directCalleeIds.map(() => '?').join(',')}) AND callee_symbol_id IS NOT NULL`,
          )
          .all(...directCalleeIds);
        for (const ic of indirectCallees) {
          if (!testedSymbols.has(ic.callee_symbol_id)) {
            indirectlyTested.add(ic.callee_symbol_id);
          }
        }
      }
    }
  }

  // 4. Get all production symbols
  const allSymbols = db
      .prepare('SELECT id, name, kind, file_path, start_line, file_id FROM code_symbols WHERE repo_id = ?')
      .all(repoId),
    // Exclusions
    entryPointPatterns = ['main.js', 'index.js', 'cli.js', 'app.js', 'server.js'],
    excludedFileIds = new Set(),
  untested = (() => {

    for (const f of allFiles) {
      const basename = path.basename(f.path);
      if (entryPointPatterns.includes(basename)) {
        excludedFileIds.add(f.id);
      }
    }
  
    // Build results with per-symbol confidence
    
  return ([]);
})();for (const sym of allSymbols) {
    // Skip test symbols themselves
    if (testFileIds.has(sym.file_id)) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    // Skip excluded patterns
    if (excludedFileIds.has(sym.file_id)) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    // Skip private symbols unless requested
    if (!includePrivate && sym.name.startsWith('_')) {
      // oxlint-disable-next-line no-continue
      continue;
    }

    if (testedSymbols.has(sym.id)) {
      // oxlint-disable-next-line no-continue
      continue;
    }

    let confidence;
    if (indirectlyTested.has(sym.id)) {
      confidence = UNDETECTED_CONFIDENCE.INDIRECTLY_TESTED;
    } else if (testImportedFiles.has(sym.file_id)) {
      confidence = UNDETECTED_CONFIDENCE.TEST_IMPORTED_FILE;
    } else {
      confidence = UNDETECTED_CONFIDENCE.NO_TEST_SIGNAL;
    }

    if (confidence >= minConfidence) {
      untested.push({ ...sym, untested_confidence: confidence });
    }
  }

  return {
    untested,
    total_symbols: allSymbols.length,
    test_files_found: testFileIds.size,
    total_files: allFiles.length,
    tested_symbols: testedSymbols.size,
    indirectly_tested: indirectlyTested.size,
  };
}

function getPrRiskProfile(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const { branch = 'HEAD', base = 'main' } = opts,
    // Get changed files between base and branch
    repo = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
  if (!repo) {
    return { error: 'Repo not found' };
  }

  let changedFiles = [];
  try {
    const diffOutput = gitDiffOutput(repo.path, base, branch, false);
    changedFiles = diffOutput ? diffOutput.split('\n').filter(Boolean) : [];
  } catch {
    changedFiles = [];
  }

  if (changedFiles.length === 0) {
    return { signals: {}, risk_level: 'low', composite: 0.0, note: 'No changed files detected.' };
  }

  // Get changed symbols
  const changedSymbolIds = new Set(),
    changedSymbols = [];
  for (const filePath of changedFiles) {
    const syms = db
      .prepare('SELECT id, name, kind, file_path FROM code_symbols WHERE repo_id = ? AND file_path = ?')
      .all(repoId, filePath);
    for (const s of syms) {
      changedSymbolIds.add(s.id);
      changedSymbols.push(s);
    }
  }

  if (changedSymbolIds.size === 0) {
    return { signals: {}, risk_level: 'low', composite: 0.1, changed_files: changedFiles.length };
  }

  // Signal 1: Blast radius (30%) — batch computation for >20 symbols
  let blastRadiusScore = 0,
  complexityScore = (() => {

    try {
      if (changedSymbolIds.size > 20) {
        // Batch: recursive CTE for all changed symbols at once
        // Use parameterized query to prevent SQL injection
        const changedIdsArr = [...changedSymbolIds],
          placeholders = changedIdsArr.map(() => '?').join(','),
          rows = db
            .prepare(`
          WITH RECURSIVE call_tree AS (
            SELECT callee_symbol_id, caller_symbol_id, 1 as depth
            FROM code_calls WHERE repo_id = ? AND callee_symbol_id IN (${placeholders})
            UNION ALL
            SELECT cc.callee_symbol_id, cc.caller_symbol_id, ct.depth + 1
            FROM code_calls cc JOIN call_tree ct ON cc.callee_symbol_id = ct.caller_symbol_id
            WHERE ct.depth < 5
          )
          SELECT callee_symbol_id, COUNT(DISTINCT caller_symbol_id) as affected_callers
          FROM call_tree GROUP BY callee_symbol_id
        `)
            .all(repoId, ...changedIdsArr),
          maxCallers = Math.max(...rows.map((r) => r.affected_callers), 1);
        blastRadiusScore = Math.min(1.0, maxCallers / PR_RISK.BLAST_RADIUS_NORMALIZER);
      } else {
        // Per-symbol blast radius for small PRs. Pass depth=5 to match the
        // Batch CTE's `ct.depth < 5` boundary above; otherwise the per-symbol
        // Path would use getBlastRadius's default depth=3 and produce a
        // Systematically smaller affected-callers count than the batch branch,
        // Causing risk scores to jump discontinuously when the changed-symbol
        // Count crosses the >20 threshold.
        let maxCallers = 0;
        for (const sid of changedSymbolIds) {
          const br = getBlastRadius(db, repoId, {
              symbol: db.prepare('SELECT name FROM code_symbols WHERE id = ?').get(sid)?.name,
              depth: 5,
            }),
            edgeCount = (br.callers || []).length;
          if (edgeCount > maxCallers) {
            maxCallers = edgeCount;
          }
        }
        blastRadiusScore = Math.min(1.0, maxCallers / PR_RISK.BLAST_RADIUS_NORMALIZER);
      }
    } catch {}
  
    // Signal 2: Complexity (20%)
    
  return (0);
})();try {
    const changedIdsArr = [...changedSymbolIds],
      placeholders = changedIdsArr.map(() => '?').join(','),
      rows = db
        .prepare(
          `SELECT MAX(sc.cyclomatic) as max_cc FROM symbol_complexity sc
       WHERE sc.symbol_id IN (${placeholders})`,
        )
        .all(...changedIdsArr),
      maxCc = rows[0]?.max_cc || 0;
    complexityScore = Math.min(1.0, maxCc / PR_RISK.COMPLEXITY_NORMALIZER);
  } catch {}

  // Signal 3: Churn (20%)
  let churnScore = 0,
  testCoverageScore = (() => {

    try {
      let maxChurn = 0;
      for (const filePath of changedFiles) {
        const row = db
          .prepare('SELECT commits FROM churn_metrics WHERE repo_id = ? AND file_path = ? AND window_days = 90')
          .get(repoId, filePath);
        if (row && row.commits > maxChurn) {
          maxChurn = row.commits;
        }
      }
      churnScore = Math.min(1.0, maxChurn / PR_RISK.CHURN_NORMALIZER);
    } catch {}
  
    // Signal 4: Test coverage (20%) — from untested detection
    
  return (0);
})(),
  changeVolumeScore = (() => {
try {
      const untestedData = getUntestedSymbols(db, repoId, { minConfidence: 0.5 });
      if (untestedData.total_files > 0 && untestedData.test_files_found > 0) {
        const untestedRatio = untestedData.untested.length / Math.max(untestedData.total_symbols, 1);
        testCoverageScore = Math.min(1.0, untestedRatio);
      }
    } catch {}
  
    // Signal 5: Change volume (10%)
    
  return (0);
})();try {
    const diffStat = gitDiffOutput(repo.path, base, branch, true),
      // Parse the last line which has the total: "X files changed, Y insertions(+), Z deletions(-)"
      totalMatch = diffStat.match(/(\d+) insertions?.*?(\d+) deletions?/);
    if (totalMatch) {
      const totalLines = parseInt(totalMatch[1]) + (parseInt(totalMatch[2]) || 0);
      changeVolumeScore = Math.min(1.0, totalLines / PR_RISK.CHANGE_VOLUME_NORMALIZER);
    }
  } catch {}

  // Composite score with weights
  const weights = PR_RISK.WEIGHTS;

  // If test coverage unavailable, redistribute weight
  let wBlastRadius = weights.blast_radius,
    wComplexity = weights.complexity,
    wChurn = weights.churn;
  const wTestCoverage = testCoverageScore > 0 ? weights.test_coverage : 0,
    wChangeVolume = weights.change_volume,
  composite = (() => {

  
    if (wTestCoverage === 0) {
      const adjustment = weights.test_coverage;
      wBlastRadius += adjustment * 0.5;
      wComplexity += adjustment * 0.25;
      wChurn += adjustment * 0.25;
    }
  
    
  return (blastRadiusScore * wBlastRadius +
    complexityScore * wComplexity +
    churnScore * wChurn +
    testCoverageScore * wTestCoverage +
    changeVolumeScore * wChangeVolume);
})(); let riskLevel = 'critical';
  if (composite <= PR_RISK.RISK_LEVELS.LOW) {
    riskLevel = 'low';
  } else if (composite <= PR_RISK.RISK_LEVELS.MEDIUM) {
    riskLevel = 'medium';
  } else if (composite <= PR_RISK.RISK_LEVELS.HIGH) {
    riskLevel = 'high';
  }

  return {
    signals: {
      blast_radius: Math.round(blastRadiusScore * 100) / 100,
      complexity: Math.round(complexityScore * 100) / 100,
      churn: Math.round(churnScore * 100) / 100,
      test_coverage: Math.round(testCoverageScore * 100) / 100,
      change_volume: Math.round(changeVolumeScore * 100) / 100,
    },
    composite: Math.round(composite * 100) / 100,
    risk_level: riskLevel,
    changed_files: changedFiles.length,
    changed_symbols: changedSymbolIds.size,
  };
}

module.exports = { getUntestedSymbols, getPrRiskProfile };
