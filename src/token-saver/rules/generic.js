const IMPORTANT_KEYWORDS =
  /\b(?:error|failed|failure|exception|todo|fixme|warning|deprecated|security|password|token|api\s?key)\b/i;

function compressGeneric({ stdout, stderr }) {
  const combined = `${stdout}\n${stderr}`.trim(),
    lines = combined ? combined.split('\n') : undefined,
    headLimit = combined ? 120 : undefined,
    tailLimit = combined ? 120 : undefined,
    head = combined && !(lines.length <= headLimit + tailLimit) ? lines.slice(0, headLimit) : undefined,
    tail = combined && !(lines.length <= headLimit + tailLimit) ? lines.slice(-tailLimit) : undefined,
    important = combined && !(lines.length <= headLimit + tailLimit) ? [] : undefined,
    omitted =
      combined && !(lines.length <= headLimit + tailLimit)
        ? (() => {
            for (let i = 0; i < lines.length; i++) {
              if (IMPORTANT_KEYWORDS.test(lines[i])) {
                important.push(`line ${i + 1}: ${lines[i]}`);
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
      summary: `${lines.length} lines of output.`,
      importantOutput: combined,
      omittedLines: 0,
    };
  }

  let output = head.join('\n');
  output += `\n\n... ${omitted} lines omitted ...\n\n`;

  if (important.length > 0) {
    output += 'Important matches:\n';
    output += important.slice(0, 50).join('\n');
    output += '\n\n';
  }

  output += tail.join('\n');

  return {
    summary: `${lines.length} lines compressed. Kept head (${headLimit}), tail (${tailLimit}), and ${Math.min(important.length, 50)} important matches.`,
    importantOutput: output,
    omittedLines: omitted,
  };
}

module.exports = { compressGeneric };
