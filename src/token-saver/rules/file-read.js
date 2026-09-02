const IMPORTANT_KEYWORDS =
  /\b(?:error|failed|exception|todo|fixme|warning|deprecated|security|password|token|api\s?key)\b/i;

function compressFileRead({ stdout, stderr }) {
  const combined = `${stdout}\n${stderr}`.trim(),
    lines = combined ? combined.split('\n') : undefined,
    headLimit = combined ? 80 : undefined,
    tailLimit = combined ? 80 : undefined,
    head = combined && !(lines.length <= headLimit + tailLimit) ? lines.slice(0, headLimit) : undefined,
    tail = combined && !(lines.length <= headLimit + tailLimit) ? lines.slice(-tailLimit) : undefined,
    important = combined && !(lines.length <= headLimit + tailLimit) ? [] : undefined,
    omitted =
      combined && !(lines.length <= headLimit + tailLimit)
        ? (() => {
            for (let i = 0; i < lines.length; i++) {
              if (IMPORTANT_KEYWORDS.test(lines[i])) {
                important.push({
                  line: i + 1,
                  text: lines[i].trim(),
                });
              }
            }

            return lines.length - headLimit - tailLimit;
          })()
        : undefined;
  if (!combined) {
    return {
      summary: 'No output.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  if (lines.length <= headLimit + tailLimit) {
    return {
      summary: `${lines.length} lines.`,
      importantOutput: combined,
      omittedLines: 0,
    };
  }

  let output = `Large file output compressed.\n\n`,
    summary = (() => {
      output += 'Head:\n';
      output += head.join('\n');
      output += '\n\n';

      if (important.length > 0) {
        output += 'Important matches:\n';
        for (const m of important.slice(0, 50)) {
          output += `line ${m.line}: ${m.text}\n`;
        }
        output += '\n';
      }

      output += `... ${omitted} lines omitted ...\n\n`;
      output += 'Tail:\n';
      output += tail.join('\n');

      return `${lines.length} lines compressed. Head/tail preserved.`;
    })();
  if (important.length > 0) {
    summary += ` ${Math.min(important.length, 50)} important line(s) found.`;
  }
  summary += ` ${omitted} lines omitted.`;

  return {
    summary,
    importantOutput: output.trim(),
    omittedLines: omitted,
  };
}

module.exports = { compressFileRead };
