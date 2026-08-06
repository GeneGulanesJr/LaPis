const obsService = require('../services/observations');
const obsDA = require('../data-access/observations');
const dedupService = require('../services/dedup');
const sessionsService = require('../services/sessions');
const { parseExpiresIn } = require('../src/memory-domain/ttl');

function getMemoryRepository(deps) {
  if (deps.memoryRepository) {
    return deps.memoryRepository;
  }
  return {
    insertObservation: (params) => obsDA.insertObservation(deps, params),
    insertObservationRelation: (params) => obsDA.insertObservationRelation(deps, params),
    softDeleteObservation: (id) => obsDA.softDeleteObservation(deps, id),
    hardDeleteObservation: (id) => obsDA.hardDeleteObservation(deps, id),
    getObservation: (id) => obsDA.getObservation(deps, id),
    getSymbolLinksForMemory: (memoryId) => obsDA.getSymbolLinksForMemory(deps, memoryId),
    getRecallCountForMemory: (memoryId) => obsDA.getRecallCountForMemory(deps, memoryId),
    getObservationVersions: (id) => obsDA.getObservationVersions(deps, id),
    getObservationRelations: (id) => obsDA.getObservationRelations(deps, id),
    updateObservation: (params) => obsDA.updateObservation(deps, params),
    getTimeline: (params) => obsDA.getTimeline(deps, params),
    insertUserPrompt: (params) => obsDA.insertUserPrompt(deps, params),
    insertCapturePassiveObservation: (params) => obsDA.insertCapturePassiveObservation(deps, params),
    getObservationStats: () => obsDA.getObservationStats(deps),
  };
}

function save(deps, args) {
  const memoryRepository = getMemoryRepository(deps);
  return obsService.save(
    {
      ...deps,
      insertObservation: (params) => memoryRepository.insertObservation(params),
      insertObservationRelation: (params) => memoryRepository.insertObservationRelation(params),
      softDeleteObservation: (id) => memoryRepository.softDeleteObservation(id),
      checkDuplicate: (title, type, project, topicKey) =>
        dedupService.checkDuplicate({ sqlJson: deps.sqlJson }, title, type, project, topicKey),
      findLatestSession: sessionsService.findLatestSession,
    },
    args,
  );
}

function get(deps, args) {
  const { jsonErrNoExit } = deps;
  const id = args.id;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }
  const memoryRepository = getMemoryRepository(deps);
  const rows = memoryRepository.getObservation(id);
  if (rows.length === 0) {
    return { error: 'Observation not found' };
  }

  const obs = rows[0];
  const links = memoryRepository.getSymbolLinksForMemory(id);
  if (links.length > 0) {
    obs.symbols = links;
  }
  const recallResult = memoryRepository.getRecallCountForMemory(id);
  obs.recall_count = recallResult[0].cnt;
  obs.versions = memoryRepository.getObservationVersions ? memoryRepository.getObservationVersions(id) : [];
  obs.relations = memoryRepository.getObservationRelations ? memoryRepository.getObservationRelations(id) : [];
  return obs;
}

function update(deps, args) {
  const { jsonErrNoExit } = deps;
  const id = args.id;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }
  const memoryRepository = getMemoryRepository(deps);

  let expiresAt;
  let clearExpiry = false;
  if (args['clear-expiry'] === 'true' || args['clear-expiry'] === true) {
    clearExpiry = true;
  } else if (args['expires-in']) {
    expiresAt = parseExpiresIn(args['expires-in']);
    if (expiresAt === null) {
      return jsonErrNoExit(
        `Invalid --expires-in value: ${args['expires-in']}. Use formats like "7d", "2w", "1m", "12h".`,
      );
    }
  } else if (args['expires-at']) {
    expiresAt = String(args['expires-at']);
  }

  const result = memoryRepository.updateObservation({
    id,
    title: args.title,
    content: args.content,
    type: args.type,
    project: args.project,
    scope: args.scope,
    topicKey: args['topic-key'],
    expiresAt,
    clearExpiry,
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
  const memoryRepository = getMemoryRepository(deps);
  const existing = memoryRepository.getObservation(id);
  if (!existing || existing.length === 0) {
    return deps.jsonErrNoExit('Observation not found');
  }
  if (hard) {
    memoryRepository.hardDeleteObservation(id);
    return { ok: true, hardDeleted: true };
  }
  memoryRepository.softDeleteObservation(id);
  return { ok: true, hardDeleted: false };
}

function timeline(deps, args) {
  const id = parseInt(args.id);
  const before = parseInt(args.before || '5', 10);
  const after = parseInt(args.after || '5', 10);
  if (isNaN(id)) {
    return deps.jsonErrNoExit('Missing --id');
  }
  const memoryRepository = getMemoryRepository(deps);
  return memoryRepository.getTimeline({ id, before, after });
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
  const memoryRepository = getMemoryRepository(deps);
  const rows = memoryRepository.insertUserPrompt({ sessionId, content, project });
  return { id: rows[0].id, created_at: rows[0].created_at };
}

function capturePassive(deps, args) {
  const memoryRepository = getMemoryRepository(deps);
  return obsService.capturePassive(
    {
      ...deps,
      insertCapturePassiveObservation: (params) => memoryRepository.insertCapturePassiveObservation(params),
      findLatestSession: sessionsService.findLatestSession,
    },
    args,
  );
}

function getStats(deps) {
  const memoryRepository = getMemoryRepository(deps);
  return memoryRepository.getObservationStats();
}

function logNegativeRecall(deps, args) {
  let entries;
  try {
    entries = JSON.parse(args.entries || '[]');
  } catch {
    return { error: 'Invalid --entries JSON' };
  }
  if (!entries.length) {
    return { logged: 0 };
  }
  obsDA.insertRecallLog(
    deps,
    entries.map((e) => ({
      memoryId: e.memoryId,
      sessionId: e.sessionId,
      query: e.query,
      wasUseful: false,
    })),
  );
  return { logged: entries.length };
}

module.exports = {
  save,
  get,
  update,
  del,
  timeline,
  suggestTopicKey,
  savePrompt,
  capturePassive,
  getStats,
  logNegativeRecall,
};
