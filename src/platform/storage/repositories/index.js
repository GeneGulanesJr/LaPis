const { createMemoryRepository } = require('./memory'),
  { createCodeIndexRepository } = require('./code-index'),
  { createDocIndexRepository } = require('./doc-index'),
  { createTrustSyncRepository } = require('./trust-sync'),
  { createAnalyticsRepository } = require('./analytics'),
  { createAurexRepository } = require('./aurex');

function createRepositories(deps) {
  return Object.freeze({
    memory: createMemoryRepository(deps),
    codeIndex: createCodeIndexRepository(deps),
    docIndex: createDocIndexRepository(deps),
    trustSync: createTrustSyncRepository(deps),
    analytics: createAnalyticsRepository(deps),
    aurex: createAurexRepository(deps),
  });
}

module.exports = {
  createRepositories,
  createMemoryRepository,
  createCodeIndexRepository,
  createDocIndexRepository,
  createTrustSyncRepository,
  createAnalyticsRepository,
  createAurexRepository,
};
