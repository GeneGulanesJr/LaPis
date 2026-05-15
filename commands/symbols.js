const trustSync = require('../src/trust-sync');

module.exports = {
  syncCodeTrust: trustSync.syncCodeTrust,
  symbolCluster: trustSync.symbolCluster,
  related: trustSync.related,
  linkSymbol: trustSync.linkSymbol,
  autoLink: trustSync.autoLink,
  adjustTrust: trustSync.adjustTrust,
  recordRecall: trustSync.recordRecall,
  staleLinks: trustSync.staleLinks,
  trustRecovery: trustSync.trustRecovery,
};
