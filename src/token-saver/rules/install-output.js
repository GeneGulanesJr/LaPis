const PROGRESS_PATTERNS =
    /(?:^npm warn|⠙|⠴|⠦|⠧|⠇|⠏|⠋|⠉|⠓|⠒|⠐|⠄|bulk|extracting|fetching|receiving|resolving|downloading|hovering|htmlandering)/i,
  WARNING_PATTERNS = /\b(?:warn|warning|peer dep|mismatch|deprecated|vulnerab)\b/i,
  ERROR_PATTERNS = /\b(?:ERR|error|ERR!|ENOENT|EACCES|404|500)\b/i,
  SUMMARY_PATTERNS = /\b(?:added|removed|changed|audited|packages|up to date|vulnerabilities)\b/i;

function compressInstallOutput({ stdout, stderr, exitCode }) {
  const combined = `${stdout}\n${stderr}`.trim(),
    lines = combined ? combined.split('\n') : undefined,
    warnings = combined ? [] : undefined,
    errors = combined ? [] : undefined,
    summaryLines = combined ? [] : undefined;
  if (!combined) {
    return {
      summary: exitCode === 0 ? 'Install completed successfully.' : 'Install failed (no output).',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  let hiddenCount = 0,
    output = (() => {
      for (const line of lines) {
        if (PROGRESS_PATTERNS.test(line) && !WARNING_PATTERNS.test(line) && !ERROR_PATTERNS.test(line)) {
          hiddenCount++;
        } else if (ERROR_PATTERNS.test(line)) {
          errors.push(line);
        } else if (WARNING_PATTERNS.test(line)) {
          warnings.push(line);
        } else if (SUMMARY_PATTERNS.test(line)) {
          summaryLines.push(line);
        } else {
          hiddenCount++;
        }
      }

      return '';
    })(),
    summary = (() => {
      if (exitCode !== 0) {
        output += 'Install FAILED.\n\n';
      } else if (warnings.length > 0 || errors.length > 0) {
        output += 'Install completed with issues.\n\n';
      } else {
        output += 'Install completed.\n\n';
      }

      if (errors.length > 0) {
        output += 'Errors:\n';
        output += errors.join('\n');
        output += '\n\n';
      }

      if (warnings.length > 0) {
        output += 'Warnings:\n';
        output += warnings.join('\n');
        output += '\n\n';
      }

      if (summaryLines.length > 0) {
        output += 'Summary:\n';
        output += summaryLines.join('\n');
        output += '\n\n';
      }

      output += `Hidden: ${hiddenCount} progress/download lines removed`;

      return exitCode === 0 ? 'Install completed.' : 'Install failed.';
    })();
  if (errors.length > 0) {
    summary += ` ${errors.length} error(s).`;
  }
  if (warnings.length > 0) {
    summary += ` ${warnings.length} warning(s).`;
  }
  summary += ` ${hiddenCount} lines hidden.`;

  return {
    summary,
    importantOutput: output.trim(),
    omittedLines: hiddenCount,
  };
}

module.exports = { compressInstallOutput };
