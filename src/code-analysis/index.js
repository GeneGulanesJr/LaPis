// Module boundary:
// Owns code intelligence queries over the code-index read model: graph, impact,
// Quality, git-aware, and risk analysis. Depends on code-index repositories and
// Git metrics; must not depend on Pi extension state or memory CRUD internals.

const graph = require('./graph'),
  impact = require('./impact'),
  quality = require('./quality'),
  gitMetrics = require('./git-metrics'),
  astPatternAnalyzers = require('./ast-patterns'),
  risk = require('./risk'),
  queryWinnow = require('./query-winnow'),
  codingContext = require('./coding-context'),
  legacy = require('./legacy-core'),
  readModel = require('./read-model');

module.exports = {
  ...graph,
  ...impact,
  ...quality,
  ...gitMetrics,
  ...astPatternAnalyzers,
  ...risk,
  ...queryWinnow,
  ...codingContext,
  ...readModel,
  buildImportGraphForFiles: legacy.buildImportGraphForFiles,
  buildCallGraphForFiles: legacy.buildCallGraphForFiles,
  buildComplexityForFiles: legacy.buildComplexityForFiles,
  clearPageRankCache: legacy.clearPageRankCache,
  buildExtendsEdges: legacy.buildExtendsEdges,
  buildImplementsEdges: legacy.buildImplementsEdges,
  buildReexportEdges: legacy.buildReexportEdges,
  buildReferenceEdges: legacy.buildReferenceEdges,
  buildCochangeEdges: legacy.buildCochangeEdges,
  getAffectedGraph: legacy.getAffectedGraph,
};
