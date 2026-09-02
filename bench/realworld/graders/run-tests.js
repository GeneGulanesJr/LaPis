#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

/**
 * Run test commands from a task definition inside a worktree.
 * @param {object} task - Task definition with success.tests array
 * @param {string} worktreePath - Absolute path to the git worktree
 * @returns {{ passed: number, failed: number, total: number, results: Array }}
 */
function runTests(task, worktreePath) {
  const testCommands = task.success?.tests;
  if (!testCommands || testCommands.length === 0) {
    return { passed: 0, failed: 0, total: 0, results: [], skipped: true };
  }

  {
const results = testCommands.map((cmd) => {
      try {
        execSync(cmd, {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { command: cmd, passed: true, stderr: '' };
      } catch (err) {
        return {
          command: cmd,
          passed: false,
          stdout: err.stdout?.toString() || '',
          stderr: err.stderr?.toString() || '',
          exitCode: err.status,
        };
      }
    }),
    passed = results.filter((r) => r.passed).length;
  return { passed, failed: results.length - passed, total: results.length, results, skipped: false };
}
}

// CLI entry point for standalone invocation
if (require.main === module) {
  const taskPath = process.argv[2],
    worktreePath = process.argv[3];
  if (!taskPath || !worktreePath) {
    console.error('Usage: node run-tests.js <task.json> <worktree-path>');
    process.exit(1);
  }
  {
const task = JSON.parse(require('fs').readFileSync(taskPath, 'utf-8')),
    result = runTests(task, worktreePath);
  console.log(JSON.stringify(result, null, 2));
}
}

module.exports = { runTests };
