const db = require('../../../db');
const { createRepositories } = require('./repositories');

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
