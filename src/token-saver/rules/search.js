const MAX_MATCHES_PER_FILE = 10,
  MAX_FILES = 30,
  MAX_OTHER_LINES = 50;

function compressSearchOutput({ stdout, stderr, commandArgs }) {
  const combined = `${stdout}\n${stderr}`.trim(),
    lines = combined ? combined.split('\n') : undefined,
    // Object.create(null): file paths come from arbitrary tool output
    // ('__proto__' must not pollute Object.prototype) (#299).
    fileMap = combined ? Object.create(null) : undefined,
    headerLines = [];
  if (!combined) {
    return {
      summary: 'No matches.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  let totalMatches = 0,
    output = '';

  for (const line of lines) {
    const match = line.match(/^(?<file>.+?):(?<lineNum>\d+):(?<text>.*)$/);
    if (match) {
      const { file: filePath, lineNum, text } = match.groups;
      if (!fileMap[filePath]) {
        fileMap[filePath] = [];
      }
      if (fileMap[filePath].length < MAX_MATCHES_PER_FILE) {
        fileMap[filePath].push({ lineNum, text: text.trim() });
      }
      totalMatches++;
    } else {
      headerLines.push(line);
    }
  }

  {
    const files = Object.keys(fileMap),
      isTruncated = files.length > MAX_FILES,
      shownFiles = files.slice(0, MAX_FILES),
      searchTerm = commandArgs.join(' '),
      omitted = (() => {
        if (searchTerm) {
          output += `Search results for "${searchTerm}":\n`;
        }
        output += `Total matches: ${totalMatches} across ${files.length} files\n\n`;

        if (shownFiles.length > 0) {
          output += 'Top files:\n';
          for (const file of shownFiles) {
            output += `${file}\n`;
            for (const m of fileMap[file]) {
              output += `- L${m.lineNum}: ${m.text}\n`;
            }
          }
        }

        if (isTruncated) {
          output += `\n... ${files.length - MAX_FILES} more files with matches not shown`;
        }

        // `grep` without -n, `grep -l` and piped `rg` print no line numbers; show those lines
        // Instead of reporting "0 matches" (#382).
        if (headerLines.length > 0) {
          output += `\nOther output:\n${headerLines.slice(0, MAX_OTHER_LINES).join('\n')}\n`;
          if (headerLines.length > MAX_OTHER_LINES) {
            output += `... ${headerLines.length - MAX_OTHER_LINES} more lines not shown\n`;
          }
        }

        return Math.max(0, totalMatches - shownFiles.reduce((sum, f) => sum + fileMap[f].length, 0));
      })();

    {
      let summary = `${totalMatches} match(es) across ${files.length} file(s).`;
      if (omitted > 0) {
        summary += ` ${omitted} matches truncated.`;
      }

      return {
        summary,
        importantOutput: output.trim(),
        omittedLines: omitted,
      };
    }
  }
}

module.exports = { compressSearchOutput };
