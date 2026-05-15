const { createMemoryRepository } = require('./memory');
const { createWorkflowRepository } = require('./workflow');
const { createCodeIndexRepository } = require('./code-index');
const { createDocIndexRepository } = require('./doc-index');
const { createTrustSyncRepository } = require('./trust-sync');
const { createAnalyticsRepository } = require('./analytics');

function createRepositories(deps) {
  return Object.freeze({
    memory: createMemoryRepository(deps),
    workflow: createWorkflowRepository(deps),
    codeIndex: createCodeIndexRepository(deps),
    docIndex: createDocIndexRepository(deps),
    trustSync: createTrustSyncRepository(deps),
    analytics: createAnalyticsRepository(deps),
  });
}

module.exports = {
  createRepositories,
  createMemoryRepository,
  createWorkflowRepository,
  createCodeIndexRepository,
  createDocIndexRepository,
  createTrustSyncRepository,
  createAnalyticsRepository,
};
