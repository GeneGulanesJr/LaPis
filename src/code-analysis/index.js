const graph = require('./graph');
const impact = require('./impact');
const quality = require('./quality');
const gitMetrics = require('./git-metrics');
const astPatternAnalyzers = require('./ast-patterns');
const risk = require('./risk');
const queryWinnow = require('./query-winnow');
const legacy = require('./legacy-core');
const readModel = require('./read-model');

module.exports = {
  ...graph,
  ...impact,
  ...quality,
  ...gitMetrics,
  ...astPatternAnalyzers,
  ...risk,
  ...queryWinnow,
  ...readModel,
  clearPageRankCache: legacy.clearPageRankCache,
};
