const { compressGitDiff } = require('./rules/git-diff');
const { compressTestOutput } = require('./rules/test-output');
const { compressInstallOutput } = require('./rules/install-output');
const { compressFileRead } = require('./rules/file-read');
const { compressListOutput } = require('./rules/list-output');
const { compressSearchOutput } = require('./rules/search');
const { compressLogs } = require('./rules/logs');
const { compressGeneric } = require('./rules/generic');

const COMPRESSORS = {
  'git-diff': compressGitDiff,
  'git-status': compressGeneric,
  test: compressTestOutput,
  install: compressInstallOutput,
  'file-read': compressFileRead,
  list: compressListOutput,
  search: compressSearchOutput,
  logs: compressLogs,
};

function compressOutput({ commandType, commandArgs, stdout, stderr, exitCode }) {
  const compressor = COMPRESSORS[commandType] || compressGeneric;
  return compressor({ stdout, stderr, exitCode, commandArgs });
}

module.exports = { compressOutput, COMPRESSORS };
