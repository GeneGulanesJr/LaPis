const symDA = require('../data-access/symbols');
const trustService = require('../services/trust');
const searchService = require('../services/search');
const codeSearchService = require('../services/code-search');

function syncCodeTrust(deps, args) {
  return trustService.syncCodeTrust({
    sqlJson: deps.sqlJson,
    jsonErrNoExit: deps.jsonErrNoExit,
    getAnchoredLinks: (repo) => symDA.getAnchoredLinks(deps, repo),
    updateLinkTrust: (params) => symDA.updateLinkTrust(deps, params),
    insertTrustAdjustment: (params) => symDA.insertTrustAdjustment(deps, params),
  }, args);
}

function symbolCluster(deps, args) {
  return searchService.symbolCluster({ sqlJson: deps.sqlJson, jsonErrNoExit: deps.jsonErrNoExit }, args);
}

function related(deps, args) {
  return searchService.related({ sqlJson: deps.sqlJson, jsonErrNoExit: deps.jsonErrNoExit }, args);
}

module.exports = { syncCodeTrust, symbolCluster, related };