// Module boundary:
// Owns code intelligence queries over the code-index read model: graph, impact,
// Quality, git-aware, and risk analysis. Depends on code-index repositories and
// Git metrics; must not depend on Pi extension state or memory CRUD internals.

const graph = require('./graph');
const impact = require('./impact');
const quality = require('./quality');
const gitMetrics = require('./git-metrics');
const astPatternAnalyzers = require('./ast-patterns');
const risk = require('./risk');
const queryWinnow = require('./query-winnow');
const codingContext = require('./coding-context');
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
