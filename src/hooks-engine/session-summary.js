'use strict';

/**
 * hooks-engine: session-summary
 *
 * Pure session-summary builder extracted from
 * extensions/memory-layer/hooks/session-lifecycle.ts:176-208. Uses
 * extractMessageText from prompt-classifiers (de-duplicated).
 */

const path = require('node:path');
const { uniqueEditedPaths } = require('../claude-code/file-keys');
const { extractMessageText } = require('./prompt-classifiers');

/**
 * Build the markdown session-summary body.
 *
 * @param {object} input
 * @param {Array} input.userMessages      raw user message entries (with .message)
 * @param {number} input.assistantCount
 * @param {number} input.turnCount
 * @param {number} input.memoriesSaved
 * @param {Set<string>|string[]} input.editedFiles
 * @param {string} input.cwd              for path.relative
 * @returns {string}
 */
function buildSessionSummary({
  userMessages = [],
  assistantCount = 0,
  turnCount = 0,
  memoriesSaved = 0,
  editedFiles = [],
  cwd = process.cwd(),
}) {
  const topics = [];
  for (const m of userMessages) {
    const text = extractMessageText(m?.message);
    if (text) {
      const firstSentence = text.split(/[.!?\n]/)[0].slice(0, 100);
      if (firstSentence && !topics.includes(firstSentence)) {
        topics.push(firstSentence);
      }
    }
  }

  const summaryParts = [
    '## Goal',
    userMessages.length > 0
      ? userMessages[0]?.message?.content?.[0]?.text?.slice(0, 200) || 'Session work'
      : 'Session work',
    '',
    '## Topics Discussed',
    ...topics.slice(0, 10).map((t) => `- ${t}`),
  ];

  const files = uniqueEditedPaths(editedFiles);
  if (files.length > 0) {
    summaryParts.push('', '## Files Modified');
    for (const f of files.slice(0, 20)) {
      summaryParts.push(`- ${path.relative(cwd, f) || f}`);
    }
  }

  summaryParts.push(
    '',
    '## Accomplished',
    `${memoriesSaved} memories saved, ${assistantCount} assistant turns, ${turnCount} total turns`,
  );

  return summaryParts.join('\n');
}

module.exports = { buildSessionSummary };
