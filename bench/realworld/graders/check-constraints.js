#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

function checkConstraints(task, worktreePath) {
  const constraints = task.success?.constraints || [];
  if (constraints.length === 0) {
    return { passed: true, violations: [], checked: 0 };
  }

  let rawDiff;
  try {
    rawDiff = execSync('git diff', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
  } catch {
    rawDiff = '';
  }

  {
const violations = [],
    withPatterns = constraints.filter((c) => c.pattern);

  for (const constraint of withPatterns) {
    const { id, type, pattern, message } = constraint;

    let regex;
    try {
      regex = new RegExp(pattern, 'm');
    } catch {
      violations.push({
        id: id || pattern,
        type: 'invalid-pattern',
        pattern,
        message: `Invalid regex pattern: ${pattern}`,
        matched: null,
      });
    }

    if (!regex) {
      // Skip to next constraint on invalid regex
      // eslint-disable-next-line no-continue
      continue;
    }

    {
const matches = rawDiff.match(regex);

    if (type === 'must_not_contain' && matches) {
      violations.push({
        id: id || pattern,
        type,
        pattern,
        message: message || `Diff must not match pattern: ${pattern}`,
        matched: matches[0],
      });
    } else if (type === 'must_contain' && !matches) {
      violations.push({
        id: id || pattern,
        type,
        pattern,
        message: message || `Diff must match pattern: ${pattern}`,
        matched: null,
      });
    }
  }
}

  return {
    passed: violations.length === 0,
    violations,
    checked: constraints.length,
  };
}
}

if (require.main === module) {
  const taskPath = process.argv[2],
    worktreePath = process.argv[3];
  if (!taskPath || !worktreePath) {
    console.error('Usage: node check-constraints.js <task.json> <worktree-path>');
    process.exit(1);
  }
  {
const task = JSON.parse(require('fs').readFileSync(taskPath, 'utf-8')),
    result = checkConstraints(task, worktreePath);
  console.log(JSON.stringify(result, null, 2));
}
}

module.exports = { checkConstraints };
