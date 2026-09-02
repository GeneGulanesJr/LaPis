const ERROR_PATTERNS = /\b(?:error|exception|fatal|panic|critical|stack\s*trace|segfault|OOM|out\s+of\s+memory)\b/i,
  TIMESTAMP_PATTERNS = /\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}/;

function compressLogs({ stdout, stderr }) {
  const combined = `${stdout}\n${stderr}`.trim(),
  lines = combined ? (combined.split('\n')) : undefined,
  errors = combined ? ([]) : undefined,
  uniqueMessages = combined ? ({}) : undefined;
  if (!combined) {
    return {
      summary: 'No log output.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  let lastTimestamp = null,
    deduped = 0;

  for (const line of lines) {
    if (ERROR_PATTERNS.test(line)) {
      errors.push(line);
    }

    const tsMatch = line.match(TIMESTAMP_PATTERNS),
    _normalized = (() => {

      if (tsMatch) {
        lastTimestamp = tsMatch[0];
      }
  
      
  return (line
      .replace(/\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}:\d{2}(?:\.\d+)?/, '<ts>')
      .replace(/\s+/g, ' ')
      .trim());
})();if (!uniqueMessages[_normalized]) {
      uniqueMessages[_normalized] = { count: 0, original: line };
    }
    uniqueMessages[_normalized].count++;
  }

  {
const recurring = Object.entries(uniqueMessages)
      .filter(([, v]) => v.count > 1)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10),
    uniqueCount = Object.keys(uniqueMessages).length,
    totalLines = lines.length;
  deduped = totalLines - uniqueCount;

  let output = 'Log summary:\n',
  summary = (() => {

    if (recurring.length > 0) {
      output += 'Recurring messages:\n';
      for (const [, info] of recurring) {
        output += `- (${info.count}x) ${info.original.slice(0, 120)}\n`;
      }
      output += '\n';
    }
  
    if (errors.length > 0) {
      output += 'Errors:\n';
      for (const err of errors.slice(0, 20)) {
        output += `${err}\n`;
      }
      output += '\n';
    }
  
    if (lastTimestamp) {
      output += `Last timestamp: ${lastTimestamp}\n`;
    }
  
    output += `\nDeduplicated: ${deduped} repeated lines removed`;
  
    
  return (`${totalLines} log lines.`);
})();if (errors.length > 0) {
    summary += ` ${errors.length} error(s) found.`;
  }
  if (recurring.length > 0) {
    summary += ` ${recurring.length} recurring message(s).`;
  }
  summary += ` ${deduped} duplicates removed.`;

  return {
    summary,
    importantOutput: output.trim(),
    omittedLines: deduped,
  };
}
}

module.exports = { compressLogs };
