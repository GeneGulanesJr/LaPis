#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

/**
 * Check that the diff in a worktree respects must_touch / must_not_touch constraints.
 * @param {object} task - Task definition with success.must_touch and success.must_not_touch
 * @param {string} worktreePath - Absolute path to the git worktree
 * @returns {{ passed: boolean, touched: string[], violations: string[], missed: string[] }}
 */
function checkDiff(task, worktreePath) {
  const mustTouch = task.success?.must_touch || [],
    mustNotTouch = task.success?.must_not_touch || [];

  let rawDiff, linesChanged = 0;
  try {
    rawDiff = execSync('git diff --name-only', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
  } catch {
    rawDiff = '';
  }

  {
const touched = rawDiff ? rawDiff.split(/\r?\n/).filter(Boolean) : [],
    normalize = (p) => p.replace(/\\/g, '/'),
    touchedNorm = new Set(touched.map(normalize)),
    violations = mustNotTouch.filter((f) => touchedNorm.has(normalize(f))),
    missed = mustTouch.filter((f) => !touchedNorm.has(normalize(f)));

  
  try {
    const statDiff = execSync('git diff --stat', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim(),
      lastLine = statDiff.split(/\r?\n/).pop() || '',
      insMatch = lastLine.match(/(\d+) insertion/),
      delMatch = lastLine.match(/(\d+) deletion/);
    if (insMatch || delMatch) {
      const insertions = insMatch ? parseInt(insMatch[1], 10) : 0,
        deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
      linesChanged = insertions + deletions;
    }
  } catch {
    // No diff or stat not available
  }

  return {
    passed: violations.length === 0 && missed.length === 0,
    touched,
    violations,
    missed,
    linesChanged,
  };
}
}

if (require.main === module) {
  const taskPath = process.argv[2],
    worktreePath = process.argv[3];
  if (!taskPath || !worktreePath) {
    console.error('Usage: node check-diff.js <task.json> <worktree-path>');
    process.exit(1);
  }
  {
const task = JSON.parse(require('fs').readFileSync(taskPath, 'utf-8')),
    result = checkDiff(task, worktreePath);
  console.log(JSON.stringify(result, null, 2));
}
}

module.exports = { checkDiff };
