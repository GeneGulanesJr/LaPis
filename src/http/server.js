const http = require('http');
const { matchRoute } = require('./routes');
const { jsonError } = require('./errors');
const { resolveHttpApiKey, requireHttpAuth, assertServeHostPolicy } = require('./auth');

function createHttpServer(deps) {
  const routes = buildRoutes(deps);
  const authorize = requireHttpAuth(deps.apiKey || null);

  const server = http.createServer(async (req, res) => {
    if (!authorize(req, res)) {
      return;
    }

    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const match = matchRoute(req.method, parsed.pathname, routes);

    if (!match) {
      return jsonError(res, 404, 'not_found', `No route for ${req.method} ${parsed.pathname}`);
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      body = await parseBody(req, res);
      if (body === undefined) {
        return;
      }
    }

    try {
      await match.handler(req, res, { params: match.params, query: parsed.searchParams, body });
    } catch (e) {
      jsonError(res, 500, 'internal_error', e.message);
    }
  });

  return server;
}

function parseBody(req, res) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        jsonError(res, 400, 'bad_request', 'Invalid JSON body');
        resolve(undefined);
      }
    });
  });
}

function buildRoutes(deps) {
  const { repositories } = deps;
  const aurex = repositories.aurex;

  const health = require('./handlers/health');
  const missions = require('./handlers/missions');
  const milestones = require('./handlers/milestones');
  const units = require('./handlers/units');
  const handoffs = require('./handlers/handoffs');
  const contracts = require('./handlers/contracts');
  const verdicts = require('./handlers/verdicts');
  const broadcasts = require('./handlers/broadcasts');
  const findings = require('./handlers/findings');
  const sessions = require('./handlers/sessions');
  const memory = require('./handlers/memory');
  const costs = require('./handlers/costs');
  const compression = require('./handlers/compression');
  const retry = require('./handlers/retry');
  const checkpoints = require('./handlers/checkpoints');
  const settings = require('./handlers/settings');
  const codeIndex = require('./handlers/code-index');
  const todos = require('./handlers/todos');
  const dispatch = require('./handlers/dispatch');

  return [
    // Health
    { method: 'GET', pattern: '/health', handler: health.healthCheck(deps) },

    // Gateway dispatch (Claude Code daemon + external callers)
    { method: 'POST', pattern: '/dispatch', handler: dispatch.dispatchCommand(deps) },

    // Missions
    { method: 'POST', pattern: '/missions', handler: missions.createMission(aurex) },
    { method: 'GET', pattern: '/missions', handler: missions.listMissions(aurex) },
    { method: 'GET', pattern: '/missions/:id', handler: missions.getMission(aurex) },
    { method: 'PATCH', pattern: '/missions/:id/status', handler: missions.updateMissionStatus(aurex) },

    // Milestones
    { method: 'POST', pattern: '/missions/:missionId/milestones', handler: milestones.createMilestone(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/milestones', handler: milestones.listMilestonesForMission(aurex) },
    { method: 'PATCH', pattern: '/milestones/:id/status', handler: milestones.updateMilestoneStatus(aurex) },

    // Working units
    { method: 'POST', pattern: '/milestones/:milestoneId/units', handler: units.createWorkingUnit(aurex) },
    { method: 'GET', pattern: '/milestones/:milestoneId/units', handler: units.getWorkingUnitsForMilestone(aurex) },
    { method: 'PATCH', pattern: '/units/:id/status', handler: units.updateWorkingUnitStatus(aurex) },

    // Handoffs
    { method: 'POST', pattern: '/units/:unitId/handoff', handler: handoffs.writeHandoff(aurex) },
    { method: 'GET', pattern: '/milestones/:milestoneId/handoffs', handler: handoffs.getHandoffsForMilestone(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/handoffs', handler: handoffs.getHandoffsForMission(aurex) },
    { method: 'GET', pattern: '/units/:unitId/handoff', handler: handoffs.getHandoffForUnit(aurex) },

    // Contracts
    { method: 'POST', pattern: '/milestones/:milestoneId/contracts', handler: contracts.createContract(aurex) },
    { method: 'POST', pattern: '/contracts/:oldId/supersede', handler: contracts.supersedeContract(aurex) },
    { method: 'GET', pattern: '/milestones/:milestoneId/contracts', handler: contracts.getContractHistory(aurex) },

    // Verdicts
    { method: 'POST', pattern: '/verdicts', handler: verdicts.writeVerdict(aurex) },
    { method: 'PATCH', pattern: '/verdicts/:id', handler: verdicts.classifyVerdict(aurex) },
    { method: 'GET', pattern: '/milestones/:milestoneId/verdicts', handler: verdicts.getVerdicts(aurex) },

    // Broadcasts
    { method: 'POST', pattern: '/broadcasts', handler: broadcasts.writeBroadcast(aurex) },
    { method: 'PATCH', pattern: '/broadcasts/:id', handler: broadcasts.transitionBroadcast(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/broadcasts', handler: broadcasts.getBroadcasts(aurex) },

    // Findings
    { method: 'POST', pattern: '/findings', handler: findings.writeFinding(aurex) },
    { method: 'PATCH', pattern: '/findings/:id', handler: findings.transitionFinding(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/findings', handler: findings.getFindings(aurex) },

    // Sessions
    { method: 'POST', pattern: '/sessions', handler: sessions.registerSession(aurex) },
    { method: 'GET', pattern: '/milestones/:milestoneId/sessions', handler: sessions.getSessionsForMilestone(aurex) },

    // Memory
    { method: 'POST', pattern: '/memory/search', handler: memory.searchMemory(deps) },

    // Costs
    { method: 'POST', pattern: '/costs', handler: costs.logCost(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/costs', handler: costs.getMissionCost(aurex) },

    // Retry / Rescope
    { method: 'POST', pattern: '/milestones/:milestoneId/retry', handler: retry.incrementRetry(aurex) },
    { method: 'POST', pattern: '/milestones/:milestoneId/rescope', handler: retry.logRescope(aurex) },

    // Mission-state compression
    { method: 'POST', pattern: '/missions/:missionId/compression', handler: compression.runCompression() },

    // Checkpoints
    { method: 'POST', pattern: '/checkpoints', handler: checkpoints.createCheckpoint(aurex) },
    { method: 'GET', pattern: '/checkpoints/:id', handler: checkpoints.getCheckpoint(aurex) },
    { method: 'PATCH', pattern: '/checkpoints/:id', handler: checkpoints.resolveCheckpoint(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/checkpoints', handler: checkpoints.getPendingCheckpoints(aurex) },

    // Todo ledgers
    { method: 'POST', pattern: '/todo-ledgers', handler: todos.createMissionLedger(aurex) },
    { method: 'GET', pattern: '/todo-ledgers', handler: todos.listMissionLedgers(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/todo-ledger', handler: todos.getMissionLedger(aurex) },
    { method: 'PATCH', pattern: '/missions/:missionId/todo-ledger', handler: todos.updateMissionLedger(aurex) },
    { method: 'PATCH', pattern: '/missions/:missionId/todo-ledger/status', handler: todos.setMissionLedgerStatus(aurex) },
    { method: 'POST', pattern: '/missions/:missionId/todo-events', handler: todos.recordMissionEvent(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/todo-events', handler: todos.listMissionEvents(aurex) },

    // Todo items
    { method: 'POST', pattern: '/missions/:missionId/todos', handler: todos.createTodo(aurex) },
    { method: 'POST', pattern: '/missions/:missionId/todos/bulk', handler: todos.createTodos(aurex) },
    { method: 'GET', pattern: '/missions/:missionId/todos', handler: todos.listTodosByMission(aurex) },
    { method: 'GET', pattern: '/todos', handler: todos.listTodos(aurex) },
    { method: 'POST', pattern: '/todos/search', handler: todos.searchTodos(aurex) },
    { method: 'POST', pattern: '/missions/:missionId/todos/claim-next', handler: todos.claimNextReadyTodo(aurex) },
    { method: 'GET', pattern: '/todos/:todoId', handler: todos.getTodo(aurex) },
    { method: 'PATCH', pattern: '/todos/:todoId', handler: todos.updateTodo(aurex) },
    { method: 'PATCH', pattern: '/todos/:todoId/status', handler: todos.setTodoStatus(aurex) },
    { method: 'POST', pattern: '/todos/:todoId/evidence', handler: todos.addTodoEvidence(aurex) },
    { method: 'POST', pattern: '/todos/:todoId/notes', handler: todos.addTodoNote(aurex) },
    { method: 'PATCH', pattern: '/todos/:todoId/assignment', handler: todos.assignTodo(aurex) },
    { method: 'GET', pattern: '/todos/:todoId/context-query', handler: todos.getTodoContextQuery(aurex) },
    { method: 'GET', pattern: '/todos/:todoId/context', handler: todos.getContextForTodo(aurex, deps) },
    { method: 'POST', pattern: '/todos/:todoId/events', handler: todos.recordTodoEvent(aurex) },
    { method: 'GET', pattern: '/todos/:todoId/events', handler: todos.listTodoEvents(aurex) },

    // Settings (KV store)
    { method: 'GET', pattern: '/settings/:key', handler: settings.getSetting(deps.sqlJson) },
    { method: 'PUT', pattern: '/settings/:key', handler: settings.setSetting(deps.sqlRun) },
    { method: 'DELETE', pattern: '/settings/:key', handler: settings.deleteSetting(deps.sqlRun) },

    // Code indexing
    { method: 'POST', pattern: '/code/index', handler: codeIndex.indexRepo(deps) },
    { method: 'POST', pattern: '/code/reindex', handler: codeIndex.reindexRepo(deps) },
    { method: 'GET', pattern: '/code/health/:repo', handler: codeIndex.codeRepoHealthHandler(deps) },
    { method: 'GET', pattern: '/code/summary/:repo', handler: codeIndex.codeRepoSummary(deps) },
    { method: 'GET', pattern: '/code/graph/:repo', handler: codeIndex.codeRepoGraph(deps) },
    { method: 'GET', pattern: '/code/hotspots/:repo', handler: codeIndex.codeRepoHotspots(deps) },
  ];
}

async function startHttpServer(opts) {
  const host = opts.host ?? '127.0.0.1';
  const port = Number(opts.port ?? 9100);
  const apiKey = resolveHttpApiKey(opts);
  assertServeHostPolicy(host, apiKey);

  const db = require('../../db');
  db.ensureDb();

  const { sqlJson, sqlRun } = db;
  const { createAurexRepository } = require('../platform/storage/repositories/aurex');
  const aurex = createAurexRepository({ sqlJson, sqlRun });

  const server = createHttpServer({
    repositories: { aurex },
    sqlJson,
    sqlRun,
    apiKey,
  });

  if (host === '0.0.0.0') {
    console.log('[lapis serve] WARNING: binding to 0.0.0.0 exposes memory APIs on your network.');
    console.log('[lapis serve] Use only on trusted networks or behind a proxy.');
    if (apiKey) {
      console.log('[lapis serve] API key authentication is enabled (x-api-key or Authorization: Bearer).');
    }
  } else if (apiKey) {
    console.log('[lapis serve] API key authentication is enabled (x-api-key or Authorization: Bearer).');
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`[lapis serve] Listening on ${host}:${port}`);
  return server;
}

module.exports = { createHttpServer, startHttpServer };
