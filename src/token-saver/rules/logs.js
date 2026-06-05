const ERROR_PATTERNS = /\b(error|exception|fatal|panic|critical|stack\s*trace|segfault|OOM|out\s+of\s+memory)\b/i;
const TIMESTAMP_PATTERNS = /\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}/;

function compressLogs({ stdout, stderr, exitCode }) {
  const combined = (stdout + '\n' + stderr).trim();
  if (!combined) {
    return {
      summary: 'No log output.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  const lines = combined.split('\n');
  const errors = [];
  const uniqueMessages = {};
  let lastTimestamp = null;
  let deduped = 0;

  for (const line of lines) {
    if (ERROR_PATTERNS.test(line)) {
      errors.push(line);
    }

    const tsMatch = line.match(TIMESTAMP_PATTERNS);
    if (tsMatch) {
      lastTimestamp = tsMatch[0];
    }

    const normalized = line.replace(/\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}:\d{2}(\.\d+)?/, '<ts>').replace(/\s+/g, ' ').trim();
    if (!uniqueMessages[normalized]) {
      uniqueMessages[normalized] = { count: 0, original: line };
    }
    uniqueMessages[normalized].count++;
  }

  const recurring = Object.entries(uniqueMessages)
    .filter(([, v]) => v.count > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  const uniqueCount = Object.keys(uniqueMessages).length;
  const totalLines = lines.length;
  deduped = totalLines - uniqueCount;

  let output = 'Log summary:\n';
  if (recurring.length > 0) {
    output += 'Recurring messages:\n';
    for (const [normalized, info] of recurring) {
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

  let summary = `${totalLines} log lines.`;
  if (errors.length > 0) {
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

module.exports = { compressLogs };
