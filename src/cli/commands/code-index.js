const codeCmd = require('../../../commands/code-impl');

const USAGE = {
  'index-repo': '--path <path> [--name NAME]',
  'index-repo-async': '--path <path> [--name NAME] [--mode full|incremental]',
  'index-status': '--job <id>',
  'list-index-jobs': '[--running] [--limit N]',
  'reindex-repo': '--repo <repo-name> [--mode full|incremental]',
  'health-code-repo': '--repo <repo-name>',
  'search-code': '--query <text> [--repo NAME] [--kind TYPE] [--max-results N]',
  'ranked-code-context': '--query <text> [--repo NAME] [--kind TYPE] [--token-budget N] [--max-results N]',
  'get-code-source':
    '--repo NAME --file PATH --name SYMBOL  (PATH may be absolute or repo-relative, e.g. lib/helper.js)',
  'list-code-repos': '',
  'remove-code-repo': '--repo <repo-name>',
};

function register(commands) {
  commands['index-repo'] = (args) => codeCmd.indexRepo(args);
  commands['reindex-repo'] = (args) => codeCmd.reindexRepo(args);
  commands['health-code-repo'] = (args) => codeCmd.codeRepoHealth(args);
  commands['search-code'] = (args) => codeCmd.searchCode(args);
  commands['ranked-code-context'] = (args) => codeCmd.rankedContext(args);
  commands['get-code-source'] = (args) => codeCmd.getCodeSource(args);
  commands['list-code-repos'] = () => codeCmd.listCodeRepos();
  commands['remove-code-repo'] = (args) => codeCmd.removeCodeRepo(args);
  commands['index-repo-async'] = (args) => codeCmd.indexRepoAsync(args);
  commands['index-status'] = (args) => codeCmd.indexStatus(args);
  commands['list-index-jobs'] = (args) => codeCmd.listIndexJobs(args);
}

module.exports = { register, USAGE };
