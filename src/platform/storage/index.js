// Module boundary:
// Owns shared storage context creation and repository composition. Feature
// Modules should receive repositories/helpers from here instead of importing
// Unrelated SQL or presentation concerns directly.

const db = require('../../../db'), { createRepositories } = require('./repositories');


function createStorageContext(overrides = {}) {
  const deps = {
    sqlJson: overrides.sqlJson || db.sqlJson,
    sqlRun: overrides.sqlRun || db.sqlRun,
    sqlRaw: overrides.sqlRaw || db.sqlRaw,
    withTransaction: overrides.withTransaction || db.withTransaction,
    jsonErrNoExit: overrides.jsonErrNoExit || db.jsonErrNoExit,
  };
  return Object.freeze({
    ...deps,
    repositories: createRepositories(deps),
  });
}

module.exports = { createStorageContext, createRepositories };
