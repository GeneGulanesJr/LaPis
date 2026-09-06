const symbols = require('../../../../data-access/symbols');

function createTrustSyncRepository(deps) {
  return Object.freeze({
    linkSymbol(params) {
      return symbols.linkSymbol(deps, params);
    },
    findUnlinked(project) {
      return symbols.findUnlinked(deps, project);
    },
    insertSymbolLink(params) {
      return symbols.insertSymbolLink(deps, params);
    },
    deletePlaceholderLinks(project) {
      return symbols.deletePlaceholderLinks(deps, project);
    },
    adjustTrust(params) {
      return symbols.adjustTrust(deps, params);
    },
    recordRecall(params) {
      return symbols.recordRecall(deps, params);
    },
    getStaleLinks(repo) {
      return symbols.getStaleLinks(deps, repo);
    },
    getAnchoredLinks(repo) {
      return symbols.getAnchoredLinks(deps, repo);
    },
    updateLinkTrust(params) {
      return symbols.updateLinkTrust(deps, params);
    },
    insertTrustAdjustment(params) {
      return symbols.insertTrustAdjustment(deps, params);
    },
    getRecalledMemoryIds(sessionId) {
      return symbols.getRecalledMemoryIds(deps, sessionId);
    },
    updateLinkTrustByMemoryId(params) {
      return symbols.updateLinkTrustByMemoryId(deps, params);
    },
    getSymbolsForMemory(memoryId) {
      return symbols.getSymbolsForMemory(deps, memoryId);
    },
    getSymbolCluster(params) {
      return symbols.getSymbolCluster(deps, params);
    },
    getRelatedMemories(params) {
      return symbols.getRelatedMemories(deps, params);
    },
  });
}

module.exports = { createTrustSyncRepository };
