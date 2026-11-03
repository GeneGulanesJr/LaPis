// Module boundary:
// Owns verifier-facing checks that run outside any prover: `verify-scan`
// (bypass detection over a git diff). Reads git and the working tree only;
// owns no tables and never writes memories. May import config, Node built-ins
// and its own files; must not import memory-domain, trust-sync or doc-index.

const fs = require('fs'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  bypass = require('./bypass');

const ALLOWLIST_FILE = '.lapis-verify-allow.json',
  GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Changed paths between `mergeBase` and the working tree, plus untracked files.
// Returns [{ file, oldPath }] with repo-relative forward-slash paths.
function changedFiles(root, mergeBase) {
  const tokens = git(root, ['diff', '--name-status', '-z', '-M', mergeBase, '--']).split('\0').filter(Boolean),
    out = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[i++],
        file = tokens[i++];
      out.push({ file, oldPath: status[0] === 'R' ? oldPath : null, status: status[0] });
    } else {
      const file = tokens[i++];
      out.push({ file, oldPath: status[0] === 'A' ? null : file, status: status[0] });
    }
  }
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    out.push({ file, oldPath: null, status: '?' });
  }
  return out;
}

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

module.exports = { scanRepo, ALLOWLIST_FILE };
