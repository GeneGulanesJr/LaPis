const sourceRetrieval = require('../src/code-index/source-retrieval');

module.exports = {
  searchCodeLike: sourceRetrieval.searchCodeLike,
  searchCode: sourceRetrieval.searchCode,
  getCodeSource: sourceRetrieval.getCodeSource,
  listCodeReposInternal: sourceRetrieval.listCodeRepos,
  removeCodeRepoInternal: sourceRetrieval.removeCodeRepo,
};
