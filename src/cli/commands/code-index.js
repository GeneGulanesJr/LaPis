const codeCmd = require('../../../commands/code-impl');

const USAGE = {
  'index-repo': '--path <path> [--name NAME]',
  'reindex-repo': '--repo <repo-name> [--mode full|incremental]',
  'search-code': '--query <text> [--repo NAME] [--kind TYPE] [--max-results N]',
  'get-code-source': '--repo NAME --file PATH --name SYMBOL',
  'list-code-repos': '',
  'remove-code-repo': '--repo <repo-name>',
};

function register(commands) {
  commands['index-repo'] = (args) => codeCmd.indexRepo(args);
  commands['reindex-repo'] = (args) => codeCmd.reindexRepo(args);
  commands['search-code'] = (args) => codeCmd.searchCode(args);
  commands['get-code-source'] = (args) => codeCmd.getCodeSource(args);
  commands['list-code-repos'] = () => codeCmd.listCodeRepos();
  commands['remove-code-repo'] = (args) => codeCmd.removeCodeRepo(args);
}

module.exports = { register, USAGE };
