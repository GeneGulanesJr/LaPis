const obsService = require('../services/observations');
const obsDA = require('../data-access/observations');
const dedupService = require('../services/dedup');
const sessionsService = require('../services/sessions');

function save(deps, args) {
  const { jsonErrNoExit } = deps;
  return obsService.save({
    ...deps,
    insertObservation: (params) => obsDA.insertObservation(deps, params),
    insertObservationRelation: (params) => obsDA.insertObservationRelation(deps, params),
    softDeleteObservation: (id) => obsDA.softDeleteObservation(deps, id),
    checkDuplicate: (title, type, project, topicKey) => dedupService.checkDuplicate({ sqlJson: deps.sqlJson }, title, type, project, topicKey),
    findLatestSession: sessionsService.findLatestSession,
  }, args);
}

function get(deps, args) {
  const { jsonErrNoExit } = deps;
  const id = args.id;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }
  const rows = obsDA.getObservation(deps, id);
  if (rows.length === 0) {
    return { error: 'Observation not found' };
  }

  const obs = rows[0];
  const links = obsDA.getSymbolLinksForMemory(deps, id);
  if (links.length > 0) {
    obs.symbols = links;
  }
  const recallResult = obsDA.getRecallCountForMemory(deps, id);
  obs.recall_count = recallResult[0].cnt;
  return obs;
}

function update(deps, args) {
  const { jsonErrNoExit } = deps;
  const id = args.id;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }
  const result = obsDA.updateObservation(deps, {
    id,
    title: args.title,
    content: args.content,
    type: args.type,
    project: args.project,
    scope: args.scope,
    topicKey: args['topic-key'],
  });
  if (result === null) {
    return jsonErrNoExit('Nothing to update');
  }
  return result.length > 0 ? result[0] : { error: 'Observation not found' };
}

function del(deps, args) {
  const id = args.id;
  const hard = args.hard === 'true' || args.hard === true;
  if (!id) {
    return deps.jsonErrNoExit('Missing --id');
  }
  if (hard) {
    obsDA.hardDeleteObservation(deps, id);
    return { ok: true, hardDeleted: true };
  }
  obsDA.softDeleteObservation(deps, id);
  return { ok: true, hardDeleted: false };
}

function timeline(deps, args) {
  const id = parseInt(args.id);
  const before = parseInt(args.before || '5', 10);
  const after = parseInt(args.after || '5', 10);
  if (isNaN(id)) {
    return deps.jsonErrNoExit('Missing --id');
  }
  return obsDA.getTimeline(deps, { id, before, after });
}

function suggestTopicKey(args) {
  return obsService.suggestTopicKey(args);
}

function savePrompt(deps, args) {
  const { jsonErrNoExit } = deps;
  const content = args.content;
  const project = args.project || null;
  const sessionId = args['session-id'] || sessionsService.findLatestSession(project);
  if (!content) {
    return jsonErrNoExit('Missing --content');
  }
  const rows = obsDA.insertUserPrompt(deps, { sessionId, content, project });
  return { id: rows[0].id, created_at: rows[0].created_at };
}

function capturePassive(deps, args) {
  return obsService.capturePassive({
    ...deps,
    insertCapturePassiveObservation: (params) => obsDA.insertCapturePassiveObservation(deps, params),
    findLatestSession: sessionsService.findLatestSession,
  }, args);
}

function getStats(deps) {
  return obsDA.getObservationStats(deps);
}

module.exports = { save, get, update, del, timeline, suggestTopicKey, savePrompt, capturePassive, getStats };