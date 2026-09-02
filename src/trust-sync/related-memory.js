const { RESULT_LIMITS } = require('../../constants'), { getTrustSyncRepository } = require('./symbol-links');


function symbolCluster(deps, args) {
  const symbolId = args.symbol || args.query,
    repo = args.repo || null,
  memories = symbolId ? (getTrustSyncRepository(deps, ['getSymbolCluster']).getSymbolCluster({ symbolId, repo })) : undefined;
  if (!symbolId) {
    return deps.jsonErrNoExit('Missing --symbol');
  }

  return { symbol: symbolId, memories };
}

function related(deps, args) {
  const rawId = args.id || args['memory-id'] || args.memoryId,
    id = parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    return deps.jsonErrNoExit('Missing --id');
  }

  {
const repository = getTrustSyncRepository(deps, ['getSymbolsForMemory', 'getRelatedMemories']),
    symbols = repository.getSymbolsForMemory(id),
  symbolIds = !(symbols.length === 0) ? (symbols.map((s) => s.symbol_id)) : undefined,
  clusters = !(symbols.length === 0) ? (repository.getRelatedMemories({ memoryId: id, symbolIds })) : undefined,
  grouped = !(symbols.length === 0) ? (new Map()) : undefined, relatedMemories = [];
  if (symbols.length === 0) {
    return { memory_id: id, related: [] };
  }

  for (const row of clusters) {
    if (!grouped.has(row.symbol_id)) {
      grouped.set(row.symbol_id, []);
    }
    if (grouped.get(row.symbol_id).length < RESULT_LIMITS.RELATED_PER_SYMBOL) {
      grouped.get(row.symbol_id).push(row);
    }
  }

  
  for (const sym of symbols) {
    const cluster = grouped.get(sym.symbol_id);
    if (cluster && cluster.length > 0) {
      relatedMemories.push({ symbol: sym.symbol_id, repo: sym.repo, memories: cluster });
    }
  }

  return { memory_id: id, related: relatedMemories };
}
}

module.exports = { symbolCluster, related };
