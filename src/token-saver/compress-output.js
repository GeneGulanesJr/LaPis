const { compressGitDiff } = require('./rules/git-diff'),
  { compressTestOutput } = require('./rules/test-output'),
  { compressInstallOutput } = require('./rules/install-output'),
  { compressFileRead } = require('./rules/file-read'),
  { compressListOutput } = require('./rules/list-output'),
  { compressSearchOutput } = require('./rules/search'),
  { compressLogs } = require('./rules/logs'),
  { compressGeneric } = require('./rules/generic'),
  COMPRESSORS = {
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
