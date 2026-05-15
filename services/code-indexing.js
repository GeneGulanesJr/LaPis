const { createParserRegistry } = require('../src/code-index/parser-registry');
const { indexRepository, reindexRepository } = require('../src/code-index/incremental-indexer');

function parseCodeFile(filePath) {
  return createParserRegistry().parseFile(filePath);
}

async function ensureParserAvailable() {
  return createParserRegistry().ensureReady();
}

async function indexRepoInternal(deps, repoPath, repoName) {
  return indexRepository(deps, repoPath, repoName);
}

async function reindexRepoInternal(deps, repo, mode) {
  return reindexRepository(deps, repo, mode);
}

module.exports = { parseCodeFile, ensureParserAvailable, indexRepoInternal, reindexRepoInternal };
