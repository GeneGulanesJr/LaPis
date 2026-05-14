const { TRUST_DELTA } = require('../constants');

function syncCodeTrust(deps, args) {
  const { sqlJson, jsonErrNoExit, getAnchoredLinks, updateLinkTrust, insertTrustAdjustment } = deps;

  const repo = args.repo;
  const changedJson = args['changed-symbols-json'] || args['changed-symbols'];
  if (!repo || !changedJson) {
    return jsonErrNoExit('Missing --repo and --changed-symbols-json');
  }

  let changedData;
  try {
    changedData = JSON.parse(changedJson);
  } catch (_) {
    return jsonErrNoExit('Invalid JSON for --changed-symbols-json');
  }

  const changedSet = new Set();
  if (Array.isArray(changedData)) {
    for (const s of changedData) {
      if (typeof s === 'string') {
        changedSet.add(s);
      } else if (s && s.symbol_id) {
        changedSet.add(s.symbol_id);
      } else if (s && s.name) {
        changedSet.add(s.name);
      }
    }
  } else if (changedData && typeof changedData === 'object') {
    for (const key of ['added', 'modified', 'removed', 'changed']) {
      const arr = changedData[key];
      if (!Array.isArray(arr)) {
        continue;
      }
      for (const s of arr) {
        if (typeof s === 'string') {
          changedSet.add(s);
        } else if (s && s.symbol_id) {
          changedSet.add(s.symbol_id);
        } else if (s && s.name) {
          changedSet.add(s.name);
        }
      }
    }
  }
  if (changedSet.size === 0) {
    return jsonErrNoExit('No changed symbols found in input');
  }

  const allLinks = getAnchoredLinks(repo);

  const result = { total: allLinks.length, adjusted: [], survived: [], unchanged: [] };

  for (const link of allLinks) {
    const isChanged = [...changedSet].some(
      (cs) => link.symbol_id === cs || link.symbol_id.endsWith(`::${cs}`) || link.symbol_id.includes(cs),
    );

    if (isChanged) {
      const delta = TRUST_DELTA.SYMBOL_CHANGED;
      const newTrust = Math.max(TRUST_DELTA.TRUST_FLOOR, link.trust_score + delta);
      updateLinkTrust({ memoryId: link.memory_id, symbolId: link.symbol_id, newTrust });
      insertTrustAdjustment({ memoryId: link.memory_id, reason: 'symbol_changed', delta });
      result.adjusted.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
    } else if (link.trust_score < TRUST_DELTA.MAX_SURVIVED) {
      const delta = TRUST_DELTA.SURVIVED_UNCHANGED;
      const newTrust = Math.min(TRUST_DELTA.TRUST_CEILING, link.trust_score + delta);
      updateLinkTrust({ memoryId: link.memory_id, symbolId: link.symbol_id, newTrust });
      insertTrustAdjustment({ memoryId: link.memory_id, reason: 'survived_unchanged', delta });
      result.survived.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
    } else {
      result.unchanged.push({ memory_id: link.memory_id, symbol_id: link.symbol_id });
    }
  }

  return result;
}

module.exports = { syncCodeTrust };