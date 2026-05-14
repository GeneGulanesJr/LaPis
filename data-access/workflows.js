const { TRUST_DELTA } = require('../constants');

function saveWorkflow(deps, { id, name, project, stepsRaw }) {
  const { sqlJson, sqlRun, jsonErrNoExit } = deps;
  if (!id || !name) {
    return jsonErrNoExit('Missing --id and --name');
  }

  sqlRun('INSERT OR IGNORE INTO procedural_memory (id, name, project) VALUES (?, ?, ?)', [id, name, project]);

  if (stepsRaw) {
    const steps = stepsRaw
      .split(/\\n|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let stepNum = 1;
    for (const cmd of steps) {
      sqlRun(
        'INSERT OR REPLACE INTO procedural_steps (workflow, step_num, command, success, attempts) VALUES (?, ?, ?, 1.0, 1)',
        [id, stepNum, cmd],
      );
      stepNum++;
    }
    return { ok: true, stepsSaved: steps.length };
  }
  return { ok: true, stepsSaved: 0 };
}

function recordStep(deps, { workflow, step, command }) {
  const { sqlRun, jsonErrNoExit } = deps;
  if (!workflow || isNaN(step) || !command) {
    return jsonErrNoExit('Missing --workflow, --step, --command');
  }
  sqlRun(
    'INSERT OR REPLACE INTO procedural_steps (workflow, step_num, command, success, attempts) VALUES (?, ?, ?, 1.0, 1)',
    [workflow, step, command],
  );
  return { ok: true };
}

function stepOutcome(deps, { workflow, step, success, workaround }) {
  const { sqlJson, sqlRun, jsonErrNoExit } = deps;
  if (!workflow || isNaN(step)) {
    return jsonErrNoExit('Missing --workflow and --step');
  }

  if (success) {
    sqlRun(
      `UPDATE procedural_steps SET success = MIN(1.0, success + ${TRUST_DELTA.STEP_SUCCESS}), attempts = attempts + 1 WHERE workflow = ? AND step_num = ?`,
      [workflow, step],
    );
  } else {
    sqlRun(
      `UPDATE procedural_steps SET success = MAX(0.0, success - ${Math.abs(TRUST_DELTA.STEP_FAILURE)}), attempts = attempts + 1, fail_workaround = ? WHERE workflow = ? AND step_num = ?`,
      [workaround || null, workflow, step],
    );
  }
  const updated = sqlJson(
    'SELECT success, attempts, fail_workaround FROM procedural_steps WHERE workflow = ? AND step_num = ?',
    [workflow, step],
  );
  return updated.length > 0 ? { ok: true, ...updated[0] } : { ok: true };
}

function getWorkflow(deps, { id }) {
  const { sqlJson, jsonErrNoExit } = deps;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }
  const meta = sqlJson('SELECT * FROM procedural_memory WHERE id = ? LIMIT 1', [id]);
  if (meta.length === 0) {
    return { error: 'Workflow not found' };
  }
  const steps = sqlJson('SELECT * FROM procedural_steps WHERE workflow = ? ORDER BY step_num', [id]);
  return { ...meta[0], steps };
}

module.exports = { saveWorkflow, recordStep, stepOutcome, getWorkflow };