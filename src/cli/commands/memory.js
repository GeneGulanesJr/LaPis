const obsCmd = require('../../../commands/observation');
const searchCmd = require('../../../commands/search');
const codeSearchService = require('../../../services/code-search');

const USAGE = {};

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
  commands.stats = () => obsCmd.getStats({ ...deps, memoryRepository });
  commands['check-dup'] = (args) => searchCmd.checkDuplicate({ sqlJson, jsonErrNoExit }, args);
  commands['mark-dup'] = (args) => searchCmd.markDuplicate({ sqlJson, sqlRun, jsonErrNoExit }, args);
}

module.exports = { register, USAGE };
