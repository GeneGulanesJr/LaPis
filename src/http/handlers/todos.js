const { jsonOk, jsonCreated, jsonError } = require('../errors');
const { mapSearchRows } = require('./memory');

function createMissionLedger(repo) {
  return async (req, res, ctx) => {
    try {
      const rows = repo.createMissionLedger(ctx.body);
      jsonCreated(res, rows[0] || null);
    } catch (e) {
      jsonError(res, 400, 'invalid_todo_ledger', e.message);
    }
  };
}

function getMissionLedger(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getMissionLedger(ctx.params.missionId);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo ledger not found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function listMissionLedgers(repo) {
  return async (req, res, ctx) => {
    try {
      jsonOk(res, repo.listMissionLedgers({ status: ctx.query.get('status') || undefined }));
    } catch (e) {
      jsonError(res, 400, 'invalid_todo_ledger_filter', e.message);
    }
  };
}

function updateMissionLedger(repo) {
  return async (req, res, ctx) => {
    try {
      const rows = repo.updateMissionLedger(ctx.params.missionId, ctx.body);
      if (rows.length === 0) {
        jsonError(res, 404, 'not_found', 'Todo ledger not found');
        return;
      }
      jsonOk(res, rows[0]);
    } catch (e) {
      jsonError(res, 400, 'invalid_todo_ledger', e.message);
    }
  };
}

function setMissionLedgerStatus(repo) {
  return async (req, res, ctx) => {
    try {
      const rows = repo.setMissionLedgerStatus(ctx.params.missionId, ctx.body.status);
      if (rows.length === 0) {
        jsonError(res, 404, 'not_found', 'Todo ledger not found');
        return;
      }
      jsonOk(res, rows[0]);
    } catch (e) {
      jsonError(res, 400, 'invalid_todo_ledger_status', e.message);
    }
  };
}

function createTodo(repo) {
  return async (req, res, ctx) => {
    try {
      const rows = repo.createTodo(ctx.params.missionId, ctx.body);
      jsonCreated(res, rows[0] || null);
    } catch (e) {
      jsonError(res, 400, 'invalid_todo', e.message);
    }
  };
}

function createTodos(repo) {
  return async (req, res, ctx) => {
    try {
      const todos = Array.isArray(ctx.body.todos) ? ctx.body.todos : ctx.body;
      jsonCreated(res, repo.createTodos(ctx.params.missionId, todos));
    } catch (e) {
      jsonError(res, 400, 'invalid_todos', e.message);
    }
  };
}

function getTodo(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getTodo(ctx.params.todoId);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function listTodos(repo) {
  return async (req, res, ctx) => {
    try {
      jsonOk(
        res,
        repo.listTodos({
          missionId: ctx.query.get('missionId') || undefined,
          status: ctx.query.get('status') || undefined,
          type: ctx.query.get('type') || undefined,
        }),
      );
    } catch (e) {
      jsonError(res, 400, 'invalid_todo_filter', e.message);
    }
  };
}

function listTodosByMission(repo) {
  return async (req, res, ctx) => {
    jsonOk(res, repo.listTodosByMission(ctx.params.missionId));
  };
}

function searchTodos(repo) {
  return async (req, res, ctx) => {
    jsonOk(res, repo.searchTodos(ctx.body.query || '', { missionId: ctx.body.missionId }));
  };
}

function updateTodo(repo) {
  return async (req, res, ctx) => {
    try {
      const rows = repo.updateTodo(ctx.params.todoId, ctx.body);
      if (rows.length === 0) {
        jsonError(res, 404, 'not_found', 'Todo not found');
        return;
      }
      jsonOk(res, rows[0]);
    } catch (e) {
      jsonError(res, 400, 'invalid_todo', e.message);
    }
  };
}

function setTodoStatus(repo) {
  return async (req, res, ctx) => {
    try {
      const rows = repo.setTodoStatus(ctx.params.todoId, ctx.body.status);
      if (rows.length === 0) {
        jsonError(res, 404, 'not_found', 'Todo not found');
        return;
      }
      jsonOk(res, rows[0]);
    } catch (e) {
      jsonError(res, 400, 'invalid_todo_status', e.message);
    }
  };
}

function addTodoEvidence(repo) {
  return async (req, res, ctx) => {
    const rows = repo.addTodoEvidence(ctx.params.todoId, ctx.body);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function addTodoNote(repo) {
  return async (req, res, ctx) => {
    const rows = repo.addTodoNote(ctx.params.todoId, ctx.body.note || '');
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function assignTodo(repo) {
  return async (req, res, ctx) => {
    const rows = repo.assignTodo(ctx.params.todoId, ctx.body.workerId || null);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function claimNextReadyTodo(repo) {
  return async (req, res, ctx) => {
    const rows = repo.claimNextReadyTodo(ctx.params.missionId, ctx.body.workerId || null);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'No ready todo found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function getTodoContextQuery(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getTodoContextQuery(ctx.params.todoId);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    jsonOk(res, rows[0]);
  };
}

function getContextForTodo(repo, deps) {
  return async (req, res, ctx) => {
    const todo = repo.getTodo(ctx.params.todoId)[0];
    if (!todo) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    if (!todo.lapisContextQuery.trim()) {
      jsonError(res, 400, 'missing_context_query', 'Todo has no lapisContextQuery');
      return;
    }
    const searchDeps = { sqlJson: deps.sqlJson, sqlRun: deps.sqlRun, jsonErrNoExit: (msg) => ({ error: msg }) },
      search = require('../../memory-domain/search').search,
      limit = ctx.query.get('limit') || '10',
      result = search(searchDeps, { query: todo.lapisContextQuery, limit });
    if (result?.error) {
      jsonError(res, 400, 'search_failed', result.error);
      return;
    }
    jsonOk(res, { todoId: todo.id, query: todo.lapisContextQuery, context: mapSearchRows(result?.results) });
  };
}

function recordTodoEvent(repo) {
  return async (req, res, ctx) => {
    const rows = repo.recordTodoEvent(ctx.params.todoId, ctx.body);
    if (rows.length === 0) {
      jsonError(res, 404, 'not_found', 'Todo not found');
      return;
    }
    jsonCreated(res, rows[0]);
  };
}

function listTodoEvents(repo) {
  return async (req, res, ctx) => {
    jsonOk(res, repo.listTodoEvents(ctx.params.todoId));
  };
}

function recordMissionEvent(repo) {
  return async (req, res, ctx) => {
    jsonCreated(res, repo.recordMissionEvent(ctx.params.missionId, ctx.body)[0]);
  };
}

function listMissionEvents(repo) {
  return async (req, res, ctx) => {
    jsonOk(res, repo.listMissionEvents(ctx.params.missionId));
  };
}

module.exports = {
  createMissionLedger,
  getMissionLedger,
  listMissionLedgers,
  updateMissionLedger,
  setMissionLedgerStatus,
  createTodo,
  createTodos,
  getTodo,
  listTodos,
  listTodosByMission,
  searchTodos,
  updateTodo,
  setTodoStatus,
  addTodoEvidence,
  addTodoNote,
  assignTodo,
  claimNextReadyTodo,
  getTodoContextQuery,
  getContextForTodo,
  recordTodoEvent,
  listTodoEvents,
  recordMissionEvent,
  listMissionEvents,
};
