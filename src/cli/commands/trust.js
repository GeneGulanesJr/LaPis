const symCmd = require('../../../commands/symbols'),
  USAGE = {
    'link-symbol': '--memory-id ID --repo X [--file PATH] [--trust N]',
    'auto-link': '--project X',
    'adjust-trust': '--memory-id ID [--delta N] [--reason R]',
    'record-recall': '--session-id ID --memory-id ID',
    'stale-links': '--repo X',
    'sync-code-trust': '--repo X',
    'symbol-cluster': '--repo X [--query Q]',
    related: '--memory-id ID [--repo X]',
  };

function register(commands, deps) {
  const { jsonErrNoExit, repositories, sqlJson, sqlRun } = deps,
    trustSyncRepository = repositories && repositories.trustSync;

  commands['link-symbol'] = (args) => symCmd.linkSymbol({ jsonErrNoExit, trustSyncRepository }, args);
  commands['auto-link'] = (args) => symCmd.autoLink({ jsonErrNoExit, trustSyncRepository }, args);
  commands['adjust-trust'] = (args) => symCmd.adjustTrust({ jsonErrNoExit, trustSyncRepository }, args);
  commands['record-recall'] = (args) => symCmd.recordRecall({ jsonErrNoExit, trustSyncRepository }, args);
  commands['stale-links'] = (args) => symCmd.staleLinks({ jsonErrNoExit, trustSyncRepository }, args);
  commands['sync-code-trust'] = (args) =>
    symCmd.syncCodeTrust({ jsonErrNoExit, repositories, sqlJson, sqlRun, trustSyncRepository }, args);
  commands['symbol-cluster'] = (args) => symCmd.symbolCluster({ jsonErrNoExit, trustSyncRepository }, args);
  commands.related = (args) => symCmd.related({ jsonErrNoExit, trustSyncRepository }, args);
}

module.exports = { register, USAGE };
