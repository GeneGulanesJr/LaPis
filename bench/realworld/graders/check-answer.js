#!/usr/bin/env node
'use strict';

const { gradeAnswer } = require('../../bench-pi-paired');

/**
 * Grade the Pi answer against expected facts.
 * @param {string} answer - Pi's assembled answer text
 * @param {Array} expectedFacts - Array of {id, description, aliases} from task.success.expected_facts
 * @returns {{ matched: number, total: number, score: number, facts: Array }}
 */
function checkAnswer(answer, expectedFacts) {
  if (!expectedFacts || expectedFacts.length === 0) {
    return { matched: 0, total: 0, score: 1, facts: [], skipped: true };
  }
  return gradeAnswer(answer, expectedFacts);
}

if (require.main === module) {
  const answer = process.argv[2],
    factsPath = process.argv[3];
  if (!answer || !factsPath) {
    console.error('Usage: node check-answer.js "<answer>" <facts.json>');
    process.exit(1);
  }
  {
    const facts = JSON.parse(require('fs').readFileSync(factsPath, 'utf-8')),
      result = checkAnswer(answer, facts);
    console.log(JSON.stringify(result, null, 2));
  }
}

module.exports = { checkAnswer };
