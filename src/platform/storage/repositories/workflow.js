const { TRUST_DELTA } = require('../../../../constants');

function createWorkflowRepository(deps) {
  const { sqlJson, sqlRun } = deps;
  const repository = {
    insertWorkflow({ id, name, project }) {
      return sqlRun('INSERT OR IGNORE INTO procedural_memory (id, name, project) VALUES (?, ?, ?)', [
        id,
        name,
        project,
      ]);
    },
    upsertStep({ workflow, stepNum, command, success, attempts }) {
      return sqlRun(
        'INSERT OR REPLACE INTO procedural_steps (workflow, step_num, command, success, attempts) VALUES (?, ?, ?, ?, ?)',
        [workflow, stepNum, command, success, attempts],
      );
    },
    recordStepSuccess({ workflow, stepNum }) {
      return sqlRun(
        `UPDATE procedural_steps SET success = MIN(1.0, success + ${TRUST_DELTA.STEP_SUCCESS}), attempts = attempts + 1 WHERE workflow = ? AND step_num = ?`,
        [workflow, stepNum],
      );
    },
    recordStepFailure({ workflow, stepNum, workaround }) {
      return sqlRun(
        `UPDATE procedural_steps SET success = MAX(0.0, success - ${Math.abs(TRUST_DELTA.STEP_FAILURE)}), attempts = attempts + 1, fail_workaround = ? WHERE workflow = ? AND step_num = ?`,
        [workaround || null, workflow, stepNum],
      );
    },
    findStepOutcome({ workflow, stepNum }) {
      return sqlJson(
        'SELECT success, attempts, fail_workaround FROM procedural_steps WHERE workflow = ? AND step_num = ?',
        [workflow, stepNum],
      );
    },
    findWorkflow(id) {
      return sqlJson('SELECT * FROM procedural_memory WHERE id = ? LIMIT 1', [id]);
    },
    listWorkflowSteps(id) {
      return sqlJson('SELECT * FROM procedural_steps WHERE workflow = ? ORDER BY step_num', [id]);
    },
    saveWorkflow(params) {
      const workflowMemory = require('../../../workflow-memory');
      return workflowMemory.saveWorkflow({ workflowRepository: repository, jsonErrNoExit: deps.jsonErrNoExit }, params);
    },
    recordStep(params) {
      const workflowMemory = require('../../../workflow-memory');
      return workflowMemory.recordStep({ workflowRepository: repository, jsonErrNoExit: deps.jsonErrNoExit }, params);
    },
    stepOutcome(params) {
      const workflowMemory = require('../../../workflow-memory');
      return workflowMemory.stepOutcome({ workflowRepository: repository, jsonErrNoExit: deps.jsonErrNoExit }, params);
    },
    getWorkflow(params) {
      const workflowMemory = require('../../../workflow-memory');
      return workflowMemory.getWorkflow({ workflowRepository: repository, jsonErrNoExit: deps.jsonErrNoExit }, params);
    },
  };

  return Object.freeze(repository);
}

module.exports = { createWorkflowRepository };
