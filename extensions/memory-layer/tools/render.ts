const COLLAPSED_LINES = 2,
  EXPANDED_LINES = 40,
  MAX_LINE_CHARS = 240;

export function renderCompactToolResult(result: any, options: any, theme: any) {
  const lines = extractTextLines(result),
    isPartial = Boolean(options?.isPartial),
    isError = Boolean(result?.isError || options?.isError);

  if (isPartial) {
    return compactText(theme.fg('warning', compactLine(lines[0] || 'Working...')));
  }

  if (lines.length === 0) {
    return compactText(theme.fg('dim', 'No output'));
  }

  const limit = options?.expanded ? EXPANDED_LINES : COLLAPSED_LINES,
    shown = lines.slice(0, limit).map(compactLine),
    hidden = lines.length - shown.length;
  let text = shown.join('\n');

  if (hidden > 0) {
    const suffix = options?.expanded
      ? `... ${hidden} more terminal lines hidden`
      : `... ${hidden} more terminal lines hidden (expand to preview more)`;
    text += `\n${theme.fg('muted', suffix)}`;
  }

  return compactText(theme.fg(isError ? 'error' : 'toolOutput', text));
}

function extractTextLines(result: any): string[] {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .flatMap((item: any) => item.text.replace(/\r/g, '').split('\n'))
    .filter((line: string) => line.trim().length > 0);
}

function compactLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_CHARS - 3)}...`;
}

function compactText(text: string) {
  return {
    render(width: number): string[] {
      const max = Math.max(1, width);
      return text.split('\n').map((line) => (line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line));
    },
    invalidate() {},
  };
}
