#!/usr/bin/env node
'use strict';

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'memory-code', 'memory-doc', 'memory-search', 'memory-get']),
  EDIT_TOOLS = new Set(['edit', 'write']),
  BASH_TOOL = 'bash';

function checkTrajectory(parsedOutput) {
  const toolCounts = parsedOutput.tool_counts || {},
    behavior = parsedOutput.behavior || {},
    totalToolCalls = behavior.tool_calls || 0,
    failedToolCalls = behavior.failed_tool_calls || 0,
    memoryToolCalls = behavior.memory_tool_calls || 0;

  let readCount = 0,
    editCount = 0,
    bashCount = 0,
  readEditRatio = (() => {

  
    for (const [tool, count] of Object.entries(toolCounts)) {
      if (READ_TOOLS.has(tool)) {
        readCount += count;
      }
      if (EDIT_TOOLS.has(tool)) {
        editCount += count;
      }
      if (tool === BASH_TOOL) {
        bashCount += count;
      }
    }
  
    
  return (0);
})();if (editCount > 0) {
    readEditRatio = readCount / (readCount + editCount);
  } else if (readCount > 0) {
    readEditRatio = 1;
  }

  const uniqueTools = Object.keys(toolCounts).length,
    errorRate = totalToolCalls > 0 ? failedToolCalls / totalToolCalls : 0;

  let score = 1.0;
  if (totalToolCalls > 0 && readCount === 0) {
    score -= 0.3;
  }
  if (totalToolCalls > 0 && editCount > 0 && readCount === 0) {
    score -= 0.2;
  }
  score -= Math.min(errorRate * 0.3, 0.3);
  if (totalToolCalls === 0) {
    score = 0;
  }
  score = Math.max(0, Math.min(1, score));

  return {
    totalToolCalls,
    readCount,
    editCount,
    bashCount,
    memoryToolCalls,
    uniqueTools,
    failedToolCalls,
    errorRate: parseFloat(errorRate.toFixed(3)),
    readEditRatio: parseFloat(readEditRatio.toFixed(3)),
    score: parseFloat(score.toFixed(3)),
  };
}

if (require.main === module) {
  const raw = require('fs').readFileSync(process.argv[2] || '/dev/stdin', 'utf-8');
  let parsed;
  try {
    const { parsePiOutput } = require('../../bench-pi-paired');
    parsed = parsePiOutput(raw);
  } catch {
    parsed = { tool_counts: {}, behavior: {} };
  }
  const result = checkTrajectory(parsed);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { checkTrajectory };
