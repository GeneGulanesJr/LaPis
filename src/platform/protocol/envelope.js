// Module boundary:
// Owns response envelopes, freshness/confidence metadata, and protocol-level
// Result shaping. Feature business logic should return data for this boundary
// To wrap rather than formatting LLM-facing responses itself.

/**
 * Response-meta.js — Metadata envelope for every analysis response
 *
 * Produces { _meta, data } shape for Pi's context-window token efficiency.
 * Pure functions for confidence/freshness computation.
 * Internal freshness cache (module-level, 60s TTL) avoids git-spawn per query.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FRESHNESS_CACHE_TTL_MS, CONFIDENCE_DEFAULTS } = require('../../../constants'),
  // ══════════════════════════════════════════════════════════
  // FRESHNESS CACHE  (module-level, 60s TTL)
  // ══════════════════════════════════════════════════════════

  _freshnessCache = new Map(); // RepoId → { value, ts }

function _cacheGet(key) {
  const entry = _freshnessCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > FRESHNESS_CACHE_TTL_MS) {
    _freshnessCache.delete(key);
    return null;
  }
  return entry.value;
}

function _cacheSet(key, value) {
  _freshnessCache.set(key, { value, ts: Date.now() });
}

// For testing: clear cache between runs
function clearFreshnessCache() {
  _freshnessCache.clear();
}

// ══════════════════════════════════════════════════════════
// FRESHNESS CHECK
// ══════════════════════════════════════════════════════════

/**
 * Determine freshness for an indexed repo.
 * Returns one of: 'fresh' | 'edited_uncommitted' | 'stale_index'
 *
 * Strategy: git state first, filesystem metadata fallback for non-git repos.
 */
function checkFreshness(repoPath, storedHeadCommit) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    return _filesystemFreshness(repoPath);
  }
  return _gitFreshness(repoPath, storedHeadCommit);
}

function _gitFreshness(repoPath, storedHeadCommit) {
  try {
    const currentHead = _resolveHead(repoPath);
    if (!currentHead || !storedHeadCommit) {
      return 'stale_index';
    }
    if (currentHead !== storedHeadCommit) {
      return 'stale_index';
    }
    return _checkUncommittedChanges(repoPath);
  } catch {
    return 'stale_index';
  }
}

function _resolveHead(repoPath) {
  return execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();
}

function _checkUncommittedChanges(repoPath) {
  const status = execSync('git status --porcelain', {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();
  return status.length > 0 ? 'edited_uncommitted' : 'fresh';
}

/**
 * Filesystem freshness for repos without a .git directory.
 * Stub: always returns 'fresh' because indexed-file mtime records are not stored,
 * so a real comparison cannot be made yet.
 */
function _filesystemFreshness(_repoPath) {
  // Without indexed-file mtime records, we can't know — assume fresh
  // Caller should pass the stored repo info for a real comparison
  return 'fresh';
}

/**
 * Cached freshness check — avoids spawning git on every query.
 */
function getFreshness(db, repoId, repoPath, storedHeadCommit) {
  const key = `freshness:${repoId}`,
    cached = _cacheGet(key),
  freshness = !(cached) ? (checkFreshness(repoPath, storedHeadCommit)) : undefined;
  if (cached) {
    return cached;
  }

  _cacheSet(key, freshness);
  return freshness;
}

// ══════════════════════════════════════════════════════════
// CONFIDENCE CALIBRATION
// ══════════════════════════════════════════════════════════

/**
 * Compute tool-specific confidence for the result set.
 *
 * Confidence is non-comparable across tools — 0.8 from getDeadCode and
 * 0.8 from getBlastRadius mean entirely different things.
 *
 * @param {string} toolName — subcommand name
 * @param {object} data — result data payload
 * @returns {number} 0.0–1.0 confidence
 */
function computeConfidence(toolName, data) {
  const calc = _confidenceCalculators[toolName];
  if (calc) {
    return calc(data);
  }
  return CONFIDENCE_DEFAULTS.UNKNOWN_TOOL;
}

const _confidenceCalculators = {
  getCouplingMetrics: () => 1.0,
  getComplexity: () => 1.0,
  getLayerViolations: () => 1.0,
  getFileOutline: () => 1.0,
  getDependencyCycles: () => 1.0,
  getImportGraph: () => 1.0,
  getCallHierarchy: () => 1.0,
  getClassHierarchy: () => 1.0,
  getSymbolImportance(data) {
    const nodes = data?.nodes || [];
    if (nodes.length < 2) {
      return nodes.length === 1 ? 1.0 : 0.0;
    }
    return Math.min(1.0, 0.5 + (nodes[0].pagerank - nodes[1].pagerank) * 20);
  },
  getDeadCode(data) {
    const symbols = data?.symbols || data?.results || [],
    sum = !(symbols.length === 0) ? (symbols.reduce((s, sym) => s + (sym.confidence || 0.5), 0)) : undefined;
    if (symbols.length === 0) {
      return 1.0;
    }
    return parseFloat((sum / symbols.length).toFixed(2));
  },
  getHotspots(data) {
    const files = data?.files || [],
    withChurn = !(files.length === 0) ? (files.filter((f) => (f.commits || 0) > 0).length) : undefined;
    if (files.length === 0) {
      return 1.0;
    }
    return parseFloat((withChurn / files.length).toFixed(2));
  },
  getBlastRadius(data) {
    const edges = data?.edges || [],
    resolved = !(edges.length === 0) ? (edges.filter((e) => e.resolved !== false).length) : undefined;
    if (edges.length === 0) {
      return 1.0;
    }
    return parseFloat((resolved / edges.length).toFixed(2));
  },
  getExtractionCandidates(data) {
    const candidates = data?.candidates || [],
    maxScore = !(candidates.length === 0) ? (Math.max(...candidates.map((c) => c.extraction_score || 0))) : undefined;
    if (candidates.length === 0) {
      return 1.0;
    }
    return maxScore <= 0 ? 0.0 : parseFloat(maxScore.toFixed(2));
  },
  getSignalChains(data) {
    const chains = data?.chains || [];
    if (chains.length === 0) {
      return 1.0;
    }
    let total = 0,
      resolved = 0;
    for (const chain of chains) {
      const steps = chain?.steps || [];
      total += steps.length;
      resolved += steps.filter((s) => s.resolved !== false).length;
    }
    return total === 0 ? 1.0 : parseFloat((resolved / total).toFixed(2));
  },
  winnow(data) {
    const results = data?.results || [];
    if (results.length === 0) {
      return 1.0;
    }
    let totalAxes = 0,
      axesWithData = 0;
    for (const r of results) {
      if (r._axes) {
        totalAxes += r._axes.total || 0;
        axesWithData += r._axes.with_data || 0;
      }
    }
    return totalAxes === 0 ? 1.0 : parseFloat((axesWithData / totalAxes).toFixed(2));
  },
  astPatterns(data) {
    const matches = data?.matches || [],
      allSymbols = data?.symbols_scanned || 0;
    if (allSymbols === 0) {
      return 1.0;
    }
    const withBody = matches.reduce((s, m) => s + (m.has_body ? 1 : 0), 0);
    return parseFloat((withBody / allSymbols).toFixed(2));
  },
  getProvenance(data) {
    const commits = data?.commits || [],
    classified = !(commits.length === 0) ? (commits.filter((c) => c.classification !== 'unknown').length) : undefined;
    if (commits.length === 0) {
      return 1.0;
    }
    return parseFloat((classified / commits.length).toFixed(2));
  },
  getUntestedSymbols(data) {
    const testFiles = data?.test_files_found || 0,
      totalFiles = data?.total_files || 1;
    return testFiles === 0 ? 0.0 : parseFloat((testFiles / totalFiles).toFixed(2));
  },
  getPrRiskProfile(data) {
    const signals = data?.signals || {},
      signalKeys = Object.keys(signals).filter((k) => k !== 'composite'),
    hasData = !(signalKeys.length === 0) ? (signalKeys.filter((k) => signals[k] != null).length) : undefined;
    if (signalKeys.length === 0) {
      return 0.0;
    }
    return parseFloat((hasData / signalKeys.length).toFixed(2));
  },
  'coding-context'(data) {
    const errors = data?.partial_errors || [],
      analyzerCount = 7;
    return parseFloat(((analyzerCount - Math.min(errors.length, analyzerCount)) / analyzerCount).toFixed(2));
  },
};

// ══════════════════════════════════════════════════════════
// RESULT COUNT EXTRACTION
// ══════════════════════════════════════════════════════════

function extractResultCount(toolName, data) {
  if (!data) {
    return 0;
  }

  switch (toolName) {
    case 'getSymbolImportance':
      return (data.nodes || []).length;
    case 'getHotspots':
      return (data.files || []).length;
    case 'getDeadCode':
      return (data.symbols || data.results || []).length;
    case 'getCouplingMetrics':
      return (data.files || data.metrics || []).length;
    case 'getExtractionCandidates':
      return (data.candidates || []).length;
    case 'getCallHierarchy':
    case 'getBlastRadius':
    case 'getImportGraph':
      return (data.edges || []).length;
    case 'getDependencyCycles':
      return (data.cycles || []).length;
    case 'getSignalChains':
      return (data.chains || []).length;
    case 'getLayerViolations':
      return (data.violations || []).length;
    case 'getFileOutline':
      return (data.classes || []).length + (data.standalone || []).length;
    case 'getClassHierarchy':
      return (data.nodes || []).length;
    case 'winnow':
      return (data.results || []).length;
    case 'astPatterns':
      return (data.matches || []).length;
    case 'getProvenance':
      return (data.commits || []).length;
    case 'getUntestedSymbols':
      return (data.untested || []).length;
    case 'getComplexity':
      return Array.isArray(data) ? data.length : (data.symbols || data.results || []).length;
    case 'getChurn':
      return (data.top_files || data.results || []).length;
    case 'getPrRiskProfile':
      return Object.keys(data?.signals || {}).length;
    case 'coding-context':
      return (
        (data.related_files || []).length +
        (data.likely_tests || []).length +
        (data.blast_radius?.affected_files || []).length
      );
    default:
      return 0;
  }
}

// ══════════════════════════════════════════════════════════
// ENVELOPE BUILDER
// ══════════════════════════════════════════════════════════

/**
 * Wrap analysis result in the _meta envelope.
 *
 * @param {object} params
 * @param {string} params.toolName — subcommand name
 * @param {object} params.data — raw analysis result
 * @param {object} params.db — SQLite handle
 * @param {number} params.repoId — code_repos.id
 * @param {string} params.repoPath — code_repos.path
 * @param {string|null} params.storedHeadCommit — code_repos.head_commit
 * @param {number} params.startTime — performance.now() from query start
 * @returns {{ _meta: object, data: object }}
 */
function buildEnvelope({ toolName, data, db, repoId, repoPath, storedHeadCommit, startTime }) {
  const now = new Date().toISOString(),
    timingMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime),
    freshness = getFreshness(db, repoId, repoPath, storedHeadCommit),
    confidence = computeConfidence(toolName, data),
    resultCount = extractResultCount(toolName, data);

  // Resolve repo_rev: current HEAD if available, stored otherwise
  let repoRev = storedHeadCommit || null;
  if (repoPath) {
    try {
      repoRev =
        execSync('git rev-parse HEAD', {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim() || repoRev;
    } catch {
      // Keep stored head_commit or null
    }
  }

  return {
    _meta: {
      schema_version: 1,
      confidence,
      freshness,
      generated_at: now,
      repo_rev: repoRev,
      timing_ms: timingMs,
      result_count: resultCount,
    },
    data,
  };
}

const TOOL_NAMES = {
  'import-graph': 'getImportGraph',
  'call-hierarchy': 'getCallHierarchy',
  'blast-radius': 'getBlastRadius',
  'dead-code': 'getDeadCode',
  complexity: 'getComplexity',
  outline: 'getFileOutline',
  churn: 'getChurn',
  hotspots: 'getHotspots',
  cycles: 'getDependencyCycles',
  importance: 'getSymbolImportance',
  coupling: 'getCouplingMetrics',
  extractable: 'getExtractionCandidates',
  hierarchy: 'getClassHierarchy',
  'signal-chains': 'getSignalChains',
  'layer-violations': 'getLayerViolations',
  winnow: 'winnow',
  'ast-patterns': 'astPatterns',
  provenance: 'getProvenance',
  untested: 'getUntestedSymbols',
  'pr-risk': 'getPrRiskProfile',
  'coding-context': 'getCodingContext',
  preflight: 'preflight',
  'agent-pack': 'agentPack',
};

function buildAnalysisEnvelope(toolName, data, repoRow, startTime, deps) {
  return buildEnvelope({
    toolName: TOOL_NAMES[toolName] || toolName,
    data,
    db: deps.getDb(),
    repoId: repoRow.id,
    repoPath: repoRow.path,
    storedHeadCommit: repoRow.head_commit || null,
    startTime,
  });
}

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════

module.exports = {
  checkFreshness,
  getFreshness,
  clearFreshnessCache,
  computeConfidence,
  extractResultCount,
  buildEnvelope,
  TOOL_NAMES,
  buildAnalysisEnvelope,
};
