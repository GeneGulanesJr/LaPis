const LOCKFILE_PATTERNS = [
  /package-lock\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/,
  /Gemfile\.lock/,
  /Cargo\.lock/,
  /go\.sum/,
  /poetry\.lock/,
];

function compressGitDiff({ stdout, stderr }) {
  const combined = `${stdout}\n${stderr}`.trim(),
  lines = combined ? (combined.split('\n')) : undefined,
  files = combined ? ([]) : undefined;
  if (!combined) {
    return {
      summary: 'No changes.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  let currentFile = null;
  const lockfileDiffs = [];
  let contextLines = 0,
    inLockfile = false,
  output = (() => {

  
    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (inLockfile && currentFile) {
          lockfileDiffs.push(currentFile);
        }
        inLockfile = false;
        const match = line.match(/diff --git a\/(?<oldPath>.+?) b\/(?<newPath>.+?)$/);
        if (match) {
          currentFile = {
            path: match.groups.newPath,
            additions: 0,
            deletions: 0,
            hunks: [],
            lockfileLines: 0,
          };
          files.push(currentFile);
          for (const lp of LOCKFILE_PATTERNS) {
            if (lp.test(match.groups.newPath)) {
              inLockfile = true;
              break;
            }
          }
        }
      } else if (inLockfile && currentFile) {
        currentFile.lockfileLines++;
      } else if (line.startsWith('@@')) {
        if (currentFile) {
          currentFile.hunks.push(line);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        if (currentFile) {
          currentFile.additions++;
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        if (currentFile) {
          currentFile.deletions++;
        }
      } else if (!line.startsWith('\\') && !line.startsWith('index ') && !line.startsWith('Binary')) {
        contextLines++;
      }
    }
  
    if (inLockfile && currentFile) {
      lockfileDiffs.push(currentFile);
    }
  
    
  return ('Git diff summary:\n');
})();for (const file of files) {
    const isLockfile = lockfileDiffs.includes(file);
    if (isLockfile) {
      output += `- ${file.path}: lockfile diff hidden (${file.lockfileLines} lines)\n`;
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

  const lockfileLines = lockfileDiffs.reduce((sum, f) => sum + f.lockfileLines, 0),
    omitted = contextLines + lockfileLines;
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
