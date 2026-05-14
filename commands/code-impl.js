const codeIndexingService = require('../services/code-indexing');
const codeSearchService = require('../services/code-search');

function indexRepo(args) {
  const repoPath = args.path;
  if (!repoPath) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: index-repo --path <path> [--name NAME]');
  }
  const path = require('path');
  const repoName = args.name || path.basename(repoPath);
  return codeIndexingService.indexRepoInternal({ db: require('../db').getDb(), args }, repoPath, repoName);
}

function reindexRepo(args) {
  const repo = args.repo;
  if (!repo) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: reindex-repo --repo <repo-name> [--mode full|incremental]');
  }
  return codeIndexingService.reindexRepoInternal({ db: require('../db').getDb(), args }, repo, args.mode || 'incremental');
}

function searchCode(args) {
  const query = args.query;
  if (!query) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: search-code --query <text> [--repo NAME] [--kind TYPE] [--max-results N]');
  }
  return codeSearchService.searchCode(query, args.repo || null, args.kind || null, parseInt(args['max-results'] || '20', 10));
}

function getCodeSource(args) {
  const repo = args.repo;
  const file = args.file;
  const name = args.name;
  if (!repo || !file || !name) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: get-code-source --repo NAME --file PATH --name SYMBOL');
  }
  return codeSearchService.getCodeSource(repo, file, name);
}

function listCodeRepos() {
  return codeSearchService.listCodeReposInternal();
}

function removeCodeRepo(args) {
  const repo = args.repo;
  if (!repo) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: remove-code-repo --repo <repo-name>');
  }
  return codeSearchService.removeCodeRepoInternal(repo);
}

module.exports = { indexRepo, reindexRepo, searchCode, getCodeSource, listCodeRepos, removeCodeRepo };