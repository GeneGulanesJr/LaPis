const searchService = require('../services/search');
const contextService = require('../services/context');
const dedupService = require('../services/dedup');
const obsDA = require('../data-access/observations');

function search(deps, args) {
  return searchService.search({ sqlJson: deps.sqlJson, sqlRun: deps.sqlRun, jsonErrNoExit: deps.jsonErrNoExit, searchCode: deps.searchCode }, args);
}

function context(deps, args) {
  return contextService.context({
    sqlJson: deps.sqlJson,
    sqlRun: deps.sqlRun,
    jsonErrNoExit: deps.jsonErrNoExit,
    obsDA,
    insertRecallLog: (entries) => obsDA.insertRecallLog(deps, entries),
    countObservationsByProjectAndType: (project) => obsDA.countObservationsByProjectAndType(deps, project),
    searchCode: deps.searchCode,
  }, args);
}

function checkDuplicate(deps, args) {
  return dedupService.checkDuplicate(
    { sqlJson: deps.sqlJson },
    args.title,
    args.type,
    args.project,
    args['topic-key'],
  );
}

function markDuplicate(deps, args) {
  return dedupService.markDuplicate({
    sqlJson: deps.sqlJson,
    sqlRun: deps.sqlRun,
    softDeleteObservation: (id) => obsDA.softDeleteObservation(deps, id),
  }, args);
}

module.exports = { search, context, checkDuplicate, markDuplicate };