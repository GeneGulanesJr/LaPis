const path = require('path'),
  { TRUST_DELTA } = require('../../constants');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function symbolMatchesChange(symbolId, changedSymbol) {
  if (symbolId === changedSymbol) {
    return true;
  }
  const symbol = String(symbolId ?? ''),
    changed = String(changedSymbol ?? ''),
    boundaryPattern = !(!symbol || !changed)
      ? new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(changed)}($|[^A-Za-z0-9_$])`)
      : undefined;
  if (!symbol || !changed) {
    return false;
  }

  return boundaryPattern.test(symbol);
}

function isChangedLink(link, changedSet) {
  for (const changedSymbol of changedSet) {
    if (symbolMatchesChange(link.symbol_id, changedSymbol)) {
      return true;
    }
  }
  return false;
}

// True when a link's recorded file path is among the changed paths. Relative
// link paths resolve against the repo root; both sides may also match via
// realpath variants (the detector stores those).
function pathInChangedPaths(symbolPath, changedPathSet, repoRoot) {
  const resolved = path.isAbsolute(symbolPath) ? path.normalize(symbolPath) : path.resolve(repoRoot || '.', symbolPath);
  if (changedPathSet.has(resolved)) {
    return true;
  }
  // Suffix fallback: the recorded path may differ from the indexed absolute
  // form by a symlinked or moved repo-root prefix.
  const tail =
    path.sep +
    path
      .normalize(symbolPath)
      .replace(/^(?:[.]{1,2}[/\\])+/, '')
      .replace(/^[/\\]+/, '');
  for (const changed of changedPathSet) {
    if (changed.endsWith(tail)) {
      return true;
    }
  }
  return false;
}

function clampTrust(value) {
  return Math.max(TRUST_DELTA.TRUST_FLOOR, Math.min(TRUST_DELTA.TRUST_CEILING, value));
}

function evaluateTrustSync(links, changedSet, changedPaths, repoRoot) {
  const result = { total: links.length, adjusted: [], survived: [], unchanged: [], operations: [] };
  const changedPathSet = changedPaths ? new Set(changedPaths) : null;

  for (const link of links) {
    // Path-aware links (recorded with a file path) only react when THAT
    // file changed — a same-named symbol changing in an unrelated file
    // must not penalize them at all (#300). Legacy path-less links keep
    // the name-based behavior below (exact full, fuzzy half).
    if (link.symbol_path && changedPathSet) {
      if (!pathInChangedPaths(link.symbol_path, changedPathSet, repoRoot)) {
        if (link.trust_score < TRUST_DELTA.MAX_SURVIVED) {
          const delta = TRUST_DELTA.SURVIVED_UNCHANGED,
            newTrust = clampTrust(link.trust_score + delta);
          result.survived.push({
            memory_id: link.memory_id,
            symbol_id: link.symbol_id,
            old_trust: link.trust_score,
            new_trust: newTrust,
          });
          result.operations.push({ link, newTrust, delta, reason: 'survived_unchanged' });
        } else {
          result.unchanged.push({ memory_id: link.memory_id, symbol_id: link.symbol_id });
        }
        continue;
      }
      // The anchor file itself changed — penalize (full). Coarse but
      // conservative: every symbol in a changed file is a candidate.
      const delta = TRUST_DELTA.SYMBOL_CHANGED,
        newTrust = clampTrust(link.trust_score + delta);
      result.adjusted.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
      result.operations.push({ link, newTrust, delta, reason: 'symbol_changed' });
      continue;
    }
    if (isChangedLink(link, changedSet)) {
      // Exact id equality is certain. A boundary match inside a larger
      // Symbol id is ambiguous — the same unqualified name usually also
      // Exists, unchanged, in other files — so it takes a reduced penalty
      // Instead of the full wipe (#300).
      const exact = changedSet.has(link.symbol_id),
        delta = exact ? TRUST_DELTA.SYMBOL_CHANGED : Math.round((TRUST_DELTA.SYMBOL_CHANGED / 2) * 100) / 100,
        newTrust = clampTrust(link.trust_score + delta);
      result.adjusted.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
      result.operations.push({
        link,
        newTrust,
        delta,
        reason: exact ? 'symbol_changed' : 'symbol_changed_fuzzy',
      });
    } else if (link.trust_score < TRUST_DELTA.MAX_SURVIVED) {
      const delta = TRUST_DELTA.SURVIVED_UNCHANGED,
        newTrust = clampTrust(link.trust_score + delta);
      result.survived.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
      result.operations.push({ link, newTrust, delta, reason: 'survived_unchanged' });
    } else {
      result.unchanged.push({ memory_id: link.memory_id, symbol_id: link.symbol_id });
    }
  }

  return result;
}

function stripOperations(result) {
  const { operations: _operations, ...publicResult } = result;
  return publicResult;
}

module.exports = { symbolMatchesChange, isChangedLink, clampTrust, evaluateTrustSync, stripOperations };
