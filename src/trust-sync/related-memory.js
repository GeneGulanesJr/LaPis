const { RESULT_LIMITS } = require('../../constants');
const { getTrustSyncRepository } = require('./symbol-links');

function symbolCluster(deps, args) {
  const symbolId = args.symbol || args.query;
  const repo = args.repo || null;
  if (!symbolId) {
    return deps.jsonErrNoExit('Missing --symbol');
  }

  const memories = getTrustSyncRepository(deps, ['getSymbolCluster']).getSymbolCluster({ symbolId, repo });
  return { symbol: symbolId, memories };
}

function related(deps, args) {
  const rawId = args.id || args['memory-id'] || args.memoryId;
  const id = parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    return deps.jsonErrNoExit('Missing --id');
  }

  const repository = getTrustSyncRepository(deps, ['getSymbolsForMemory', 'getRelatedMemories']);
  const symbols = repository.getSymbolsForMemory(id);
  if (symbols.length === 0) {
    return { memory_id: id, related: [] };
  }

  const symbolIds = symbols.map((s) => s.symbol_id);
  const clusters = repository.getRelatedMemories({ memoryId: id, symbolIds });
  const grouped = new Map();
  for (const row of clusters) {
    if (!grouped.has(row.symbol_id)) {
      grouped.set(row.symbol_id, []);
    }
    if (grouped.get(row.symbol_id).length < RESULT_LIMITS.RELATED_PER_SYMBOL) {
      grouped.get(row.symbol_id).push(row);
    }
  }

  const relatedMemories = [];
  for (const sym of symbols) {
    const cluster = grouped.get(sym.symbol_id);
    if (cluster && cluster.length > 0) {
      relatedMemories.push({ symbol: sym.symbol_id, repo: sym.repo, memories: cluster });
    }
  }

  return { memory_id: id, related: relatedMemories };
}

module.exports = { symbolCluster, related };
