const obsCmd = require('../../../commands/observation');
const searchCmd = require('../../../commands/search');
const codeSearchService = require('../../../services/code-search');

const USAGE = {
  save: '--title <title> --content <content> [--type TYPE] [--project NAME] [--scope SCOPE] [--topic-key KEY] [--force] [--expires-in DUR] [--session-id ID]',
  get: '--id ID',
  update:
    '--id ID [--title T] [--content C] [--type T] [--project P] [--scope S] [--topic-key K] [--expires-in DUR] [--expires-at TS] [--clear-expiry]',
  delete: '--id ID [--hard]',
  timeline: '--id ID [--before N] [--after N]',
  search: '--query <text> [--project NAME] [--type TYPE] [--scope SCOPE] [--limit N]',
  context:
    '--query <text> [--project NAME] [--limit N] [--token-budget N] [--session-id ID] [--topic-key KEY] [--deep] [--all-projects]',
  'suggest-topic-key': '[--title T] [--content C]',
  'save-prompt': '--content <text> [--project NAME] [--session-id ID]',
  'capture-passive': '--content <text>',
  stats: '',
  'check-dup': '--title T [--type TYPE] [--project NAME] [--topic-key KEY]',
  'mark-dup': '--source ID --target ID [--confidence N]',
  'log-negative-recall': '--entries <json-array>',
};

function register(commands, deps) {
  const { sqlJson, sqlRun, sqlRaw, jsonErrNoExit, repositories } = deps;
  const memoryRepository = repositories && repositories.memory;

  commands.save = (args) => obsCmd.save({ sqlJson, sqlRun, sqlRaw, jsonErrNoExit, memoryRepository }, args);
  commands.search = (args) =>
    searchCmd.search(
      {
        sqlJson,
        sqlRun,
        jsonErrNoExit,
        searchCode: (q, repo, kind, limit) => codeSearchService.searchCode(q, repo, kind, limit),
      },
      args,
    );
  commands.context = (args) =>
    searchCmd.context(
      {
        sqlJson,
        sqlRun,
        jsonErrNoExit,
        searchCode: (q, repo, kind, limit) => codeSearchService.searchCode(q, repo, kind, limit),
      },
      args,
    );
  commands.get = (args) => obsCmd.get({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.update = (args) => obsCmd.update({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.delete = (args) => obsCmd.del({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.timeline = (args) => obsCmd.timeline({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['suggest-topic-key'] = (args) => obsCmd.suggestTopicKey(args);
  commands['save-prompt'] = (args) => obsCmd.savePrompt({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['capture-passive'] = (args) =>
    obsCmd.capturePassive({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['log-negative-recall'] = (args) =>
    obsCmd.logNegativeRecall({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.stats = () => obsCmd.getStats({ ...deps, memoryRepository });
  commands['check-dup'] = (args) => searchCmd.checkDuplicate({ sqlJson, jsonErrNoExit }, args);
  commands['mark-dup'] = (args) => searchCmd.markDuplicate({ sqlJson, sqlRun, jsonErrNoExit }, args);
}

module.exports = { register, USAGE };
