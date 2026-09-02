const { TRUST_DELTA } = require('../../constants');

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

function clampTrust(value) {
  return Math.max(TRUST_DELTA.TRUST_FLOOR, Math.min(TRUST_DELTA.TRUST_CEILING, value));
}

function evaluateTrustSync(links, changedSet) {
  const result = { total: links.length, adjusted: [], survived: [], unchanged: [], operations: [] };

  for (const link of links) {
    if (isChangedLink(link, changedSet)) {
      const delta = TRUST_DELTA.SYMBOL_CHANGED,
        newTrust = clampTrust(link.trust_score + delta);
      result.adjusted.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
      result.operations.push({ link, newTrust, delta, reason: 'symbol_changed' });
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
