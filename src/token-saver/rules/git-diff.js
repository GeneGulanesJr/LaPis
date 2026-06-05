const LOCKFILE_PATTERNS = [
  /package-lock\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/,
  /Gemfile\.lock/,
  /Cargo\.lock/,
  /go\.sum/,
  /poetry\.lock/,
];

function compressGitDiff({ stdout, stderr, exitCode }) {
  const combined = (stdout + '\n' + stderr).trim();
  if (!combined) {
    return {
      summary: 'No changes.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  const lines = combined.split('\n');
  const files = [];
  let currentFile = null;
  let hunks = [];
  let lockfileDiffs = [];
  let lockfileLines = 0;
  let contextLines = 0;
  let inLockfile = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (inLockfile && currentFile) {
        lockfileDiffs.push(currentFile);
      }
      inLockfile = false;
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = {
          path: match[2],
          additions: 0,
          deletions: 0,
          hunks: [],
        };
        files.push(currentFile);
        for (const lp of LOCKFILE_PATTERNS) {
          if (lp.test(match[2])) {
            inLockfile = true;
            break;
          }
        }
      }
      continue;
    }

    if (inLockfile) {
      lockfileLines++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (currentFile) {
        currentFile.hunks.push(line);
      }
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) currentFile.additions++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (currentFile) currentFile.deletions++;
      continue;
    }
    if (!line.startsWith('\\') && !line.startsWith('index ') && !line.startsWith('Binary')) {
      contextLines++;
    }
  }

  if (inLockfile && currentFile) {
    lockfileDiffs.push(currentFile);
  }

  let output = 'Git diff summary:\n';
  for (const file of files) {
    const isLockfile = lockfileDiffs.includes(file);
    if (isLockfile) {
      output += `- ${file.path}: lockfile diff hidden (${lockfileLines} lines)\n`;
    } else {
      output += `- ${file.path}: modified, +${file.additions} -${file.deletions}\n`;
    }
  }

  const nonLockfiles = files.filter((f) => !lockfileDiffs.includes(f));
  if (nonLockfiles.length > 0) {
    output += '\nImportant hunks:\n';
    for (const file of nonLockfiles.slice(0, 20)) {
      output += `${file.path}\n`;
      for (const hunk of file.hunks.slice(0, 10)) {
        output += `${hunk}\n`;
      }
    }
  }

  const totalLines = lines.length;
  const omitted = contextLines + lockfileLines;
  let summary = `${files.length} file(s) changed.`;
  if (lockfileDiffs.length > 0) {
    summary += ` ${lockfileDiffs.length} lockfile diff(s) hidden.`;
  }
  summary += ` ${omitted} context/lockfile lines omitted.`;

  return {
    summary,
    importantOutput: output.trim(),
    omittedLines: omitted,
  };
}

module.exports = { compressGitDiff };
