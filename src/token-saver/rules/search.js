const MAX_MATCHES_PER_FILE = 10,
  MAX_FILES = 30;

function compressSearchOutput({ stdout, stderr, commandArgs }) {
  const combined = `${stdout}\n${stderr}`.trim(),
  lines = combined ? (combined.split('\n')) : undefined,
  fileMap = combined ? ({}) : undefined, headerLines = [];
  if (!combined) {
    return {
      summary: 'No matches.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  let totalMatches = 0, output = '';
  

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
    shownFiles = files.slice(0, MAX_FILES), searchTerm = commandArgs.join(' '),
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
  
    
  return (Math.max(0, totalMatches - shownFiles.reduce((sum, f) => sum + fileMap[f].length, 0)));
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
