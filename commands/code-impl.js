const codeIndexingService = require('../services/code-indexing'),
  codeSearchService = require('../services/code-search');

async function indexRepo(args) {
  const repoPath = args.path;
  if (!repoPath) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: index-repo --path <path> [--name NAME]');
  }
  const path = require('path'),
    repoName = args.name || path.basename(repoPath);
  // Auto-switch to async when --async, when file count exceeds the configured
  // Threshold, or for explicit full reindex (already slow on large repos).
  if (args.async === 'true' || args.mode === 'full') {
    return codeIndexingService.indexRepoAsyncInternal({}, repoPath, repoName, { mode: 'full' });
  }
  {
    const { getConfig } = require('../config'),
      threshold = getConfig().async_index_file_threshold || 500;
    let fileCount = 0;
    try {
      const { scanRepository } = require('../src/code-index/scanner'),
        scan = scanRepository(repoPath, { ignore: [], respectGitignore: true });
      fileCount = scan && scan.files ? scan.files.length : 0;
    } catch (_) {
      /* Scan errors are not fatal — fall through to sync */
    }
    if (fileCount >= threshold) {
      process.stderr.write(
        `${JSON.stringify({ notice: `Repository has ${fileCount} files (threshold ${threshold}); auto-switching to async.`, fileCount, threshold })}\n`,
      );
      return codeIndexingService.indexRepoAsyncInternal({}, repoPath, repoName, { mode: 'full' });
    }
    return codeIndexingService.indexRepoInternal({ db: require('../db').getDb(), args }, repoPath, repoName);
  }
}

async function indexRepoAsync(args) {
  const repoPath = args.path;
  if (!repoPath) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: index-repo-async --path <path> [--name NAME] [--mode full|incremental]');
  }
  const path = require('path'),
    repoName = args.name || path.basename(repoPath);
  return codeIndexingService.indexRepoAsyncInternal({}, repoPath, repoName, { mode: args.mode || 'full' });
}

function indexStatus(args) {
  const jobId = parseInt(args.job, 10);
  if (!jobId || Number.isNaN(jobId)) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: index-status --job <id>');
  }
  return codeIndexingService.indexStatusInternal(jobId);
}

function listIndexJobs(args) {
  return codeIndexingService.listIndexJobsInternal({
    onlyRunning: args.running === 'true',
    limit: parseInt(args.limit || '20', 10),
  });
}

function reindexRepo(args) {
  const repo = args.repo;
  if (!repo) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: reindex-repo --repo <repo-name> [--mode full|incremental]');
  }
  return codeIndexingService.reindexRepoInternal(
    { db: require('../db').getDb(), args },
    repo,
    args.mode || 'incremental',
  );
}

function codeRepoHealth(args) {
  const repo = args.repo;
  if (!repo) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: health-code-repo --repo <repo-name>');
  }
  return codeIndexingService.codeRepoHealthInternal({ db: require('../db').getDb(), args }, repo);
}

function searchCode(args) {
  const query = args.query;
  if (!query) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: search-code --query <text> [--repo NAME] [--kind TYPE] [--max-results N]');
  }
  return codeSearchService.searchCode(
    query,
    args.repo || null,
    args.kind || null,
    parseInt(args['max-results'] || '20', 10),
  );
}

function rankedContext(args) {
  const query = args.query;
  if (!query) {
    const { jsonErrNoExit } = require('../db');
    return jsonErrNoExit('Usage: ranked-code-context --query <text> [--repo NAME] [--token-budget N]');
  }
  return codeSearchService.rankedContext(query, args.repo || null, {
    tokenBudget: parseInt(args['token-budget'] || args.tokenBudget || '4000', 10),
    maxResults: parseInt(args['max-results'] || '20', 10),
    kind: args.kind || null,
  });
}

function getCodeSource(args) {
  const repo = args.repo,
    file = args.file,
    name = args.name;
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

module.exports = {
  indexRepo,
  indexRepoAsync,
  indexStatus,
  listIndexJobs,
  reindexRepo,
  codeRepoHealth,
  searchCode,
  rankedContext,
  getCodeSource,
  listCodeRepos,
  removeCodeRepo,
};
