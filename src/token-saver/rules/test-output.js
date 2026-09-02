const FAIL_PATTERNS = /\b(?:FAIL|failed|failure|error|Error|ERR)\b/,
  PASS_PATTERNS = /\b(?:PASS|passed|✓|✔|✅)\b/,
  SUMMARY_PATTERNS = /(?:Tests|Test Suites|Snapshots|Time|Ran|total|passed|failed|skipped|todo)/i,
  DIFF_PATTERNS = /(?:\bExpected\b|\bReceived\b|\+.*|-.*|@@.*@@)/,
  WATCH_HINT = /(?:Watch Usage|watch mode|Press.*to.*more|--watch)/i,
  COVERAGE_PATTERNS = /(?:coverage|Statements|Branches|Functions|Lines|All files)/i;

function compressTestOutput({ stdout, stderr, exitCode }) {
  const combined = `${stdout}\n${stderr}`.trim(),
    lines = combined ? combined.split('\n') : undefined,
    kept = combined ? [] : undefined,
    failedBlocks = combined ? [] : undefined;
  if (!combined) {
    return {
      summary: exitCode === 0 ? 'All tests passed (no output).' : 'Tests failed (no output).',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  let inFailure = false,
    failureBuf = [],
    hiddenCount = 0;
  {
    const summaryLines = [],
      coverageLines = [],
      result = (() => {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          if (WATCH_HINT.test(line)) {
            hiddenCount++;
          } else if (/^\s*(?:PASS|✓|✔)/.test(line) && !FAIL_PATTERNS.test(line)) {
            hiddenCount++;
          } else if (/^\s*(?:FAIL|✗|✘|×)/.test(line) || (/FAIL/i.test(line) && !PASS_PATTERNS.test(line))) {
            inFailure = true;
            failureBuf = [line];
          } else if (SUMMARY_PATTERNS.test(line) && !FAIL_PATTERNS.test(line) && !inFailure) {
            summaryLines.push(line);
          } else if (COVERAGE_PATTERNS.test(line) && !inFailure) {
            coverageLines.push(line);
          } else if (DIFF_PATTERNS.test(line) || FAIL_PATTERNS.test(line)) {
            if (inFailure) {
              failureBuf.push(line);
            } else {
              kept.push(line);
            }
          } else if (inFailure) {
            if (line.trim() === '' && failureBuf.length > 2) {
              failedBlocks.push(failureBuf.join('\n'));
              inFailure = false;
              failureBuf = [];
            } else {
              failureBuf.push(line);
            }
          } else {
            hiddenCount++;
          }
        }

        if (inFailure && failureBuf.length > 0) {
          failedBlocks.push(failureBuf.join('\n'));
        }

        return exitCode === 0 ? 'PASSED' : 'FAILED';
      })(),
      failCount = failedBlocks.length;
    let output = `Test result: ${result}\n\n`;

    if (summaryLines.length > 0) {
      output += 'Summary:\n';
      output += summaryLines.join('\n');
      output += '\n\n';
    }

    if (failedBlocks.length > 0) {
      output += 'Failures:\n';
      output += failedBlocks.join('\n---\n');
      output += '\n\n';
    }

    if (coverageLines.length > 0 && coverageLines.length < 30) {
      output += 'Coverage:\n';
      output += coverageLines.join('\n');
      output += '\n\n';
    }

    if (kept.length > 0) {
      output += 'Important output:\n';
      output += kept.join('\n');
      output += '\n';
    }

    output += `Hidden: ${hiddenCount} passed/progress lines removed`;

    {
      let summary = `Tests ${result.toLowerCase()}.`;
      if (failCount > 0) {
        summary += ` ${failCount} failure block(s) extracted.`;
      }
      summary += ` ${hiddenCount} lines hidden.`;

      return {
        summary,
        importantOutput: output.trim(),
        omittedLines: hiddenCount,
      };
    }
  }
}

module.exports = { compressTestOutput };
