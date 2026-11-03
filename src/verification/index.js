// Module boundary:
// Owns verifier-facing checks: `verify-scan` (bypass detection over a git
// diff) and verifier results (`verify-ingest`, `proof-state`, tables
// verifier_runs / verifier_results). Never writes memories: a proof result is
// a hint about one commit, not proof the current code is correct. May import
// config, Node built-ins and its own files; must not import memory-domain,
// trust-sync or doc-index.

const fs = require('fs'),
  path = require('path'),
  bypass = require('./bypass'),
  { git, changedFiles } = require('./git'),
  { ingestReport, proofState } = require('./results'),
  { captureCheckOutput } = require('./capture');

const ALLOWLIST_FILE = '.lapis-verify-allow.json';

function readOld(root, mergeBase, oldPath) {
  if (!oldPath) {
    return '';
  }
  try {
    return git(root, ['show', `${mergeBase}:${oldPath}`]);
  } catch {
    return '';
  }
}

function readNew(root, file) {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return ''; // deleted in the working tree
  }
}

function loadAllowlist(root) {
  const p = path.join(root, ALLOWLIST_FILE);
  if (!fs.existsSync(p)) {
    return { entries: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { error: `${ALLOWLIST_FILE}: invalid JSON (${e.message})` };
  }
  const result = bypass.validateAllowlist(raw);
  return result.error ? { error: `${ALLOWLIST_FILE}: ${result.error}` } : result;
}

/**
 * Scan everything that changed since the merge-base of `base` and HEAD
 * (committed, staged, unstaged and untracked). High-severity findings not
 * covered by the allowlist fail the scan (exit_code 1).
 */
function scanRepo({ cwd = process.cwd(), base = 'HEAD' } = {}) {
  if (typeof base !== 'string' || !base || base.startsWith('-')) {
    return { error: `Invalid --base "${base}"` };
  }
  let root, mergeBase;
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return { error: `Not a git repository: ${cwd}` };
  }
  try {
    mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  } catch {
    return { error: `Cannot find a merge-base between "${base}" and HEAD` };
  }

  const allow = loadAllowlist(root);
  if (allow.error) {
    return { error: allow.error };
  }

  const changed = changedFiles(root, mergeBase);
  let findings = [],
    scanned = 0;
  for (const c of changed) {
    if (c.file === ALLOWLIST_FILE) {
      findings.push({
        rule: 'allowlist-changed',
        severity: 'warning',
        file: c.file,
        line: null,
        text: '',
        message: 'Bypass allowlist changed: new exceptions need human review.',
      });
      continue;
    }
    if (!bypass.languageOf(c.file) && !bypass.languageOf(c.oldPath || '')) {
      continue;
    }
    scanned++;
    findings = findings.concat(
      bypass.scanFilePair({
        file: c.file,
        oldPath: c.oldPath,
        oldText: readOld(root, mergeBase, c.oldPath),
        newText: c.status === 'D' ? '' : readNew(root, c.file),
      }),
    );
  }
  findings = bypass.applyAllowlist(findings, allow.entries);

  const blocking = findings.filter((f) => f.severity === 'high' && !f.allowed),
    passed = blocking.length === 0;
  return {
    base,
    merge_base: mergeBase,
    files_scanned: scanned,
    findings,
    summary: {
      high: blocking.length,
      warning: findings.filter((f) => f.severity === 'warning' && !f.allowed).length,
      allowed: findings.filter((f) => f.allowed).length,
    },
    passed,
    exit_code: passed ? 0 : 1,
  };
}

/** Config helpers: verification on/off and the stop gate (gate implies enabled). */
function verificationEnabled(config) {
  return !config || !config.verification || config.verification.enabled !== false;
}
function gateEnabled(config) {
  return verificationEnabled(config) && !(config && config.verification && config.verification.gate === false);
}

module.exports = {
  scanRepo,
  ingestReport,
  proofState,
  captureCheckOutput,
  verificationEnabled,
  gateEnabled,
  ALLOWLIST_FILE,
};
