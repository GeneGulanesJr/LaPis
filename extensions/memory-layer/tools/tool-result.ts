export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function toolTextResult(text: unknown, details: unknown = {}, isError = false): ToolTextResult {
  return normalizeToolResult({
    content: [{ type: 'text', text: stringifyToolText(text) }],
    details,
    isError,
  });
}

export function toolProgressResult(message: unknown, details: unknown = {}): ToolTextResult {
  return toolTextResult(stringifyToolText(message), details, false);
}

export function normalizeToolResult(result: unknown, fallbackText = 'No output.'): ToolTextResult {
  if (!result || typeof result !== 'object') {
    return {
      content: [{ type: 'text', text: stringifyToolText(result) || fallbackText }],
      details: {},
      isError: true,
    };
  }

  const candidate = result as Record<string, unknown>,
    content = Array.isArray(candidate.content) ? candidate.content : [],
    normalizedContent = content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => {
        if (item.type === 'text') {
          return { ...item, text: stringifyToolText(item.text) };
        }
        return item;
      }),
  details = (() => {

  
    if (normalizedContent.length === 0) {
      normalizedContent.push({ type: 'text', text: fallbackText });
    }
  
    
  return (candidate.details && typeof candidate.details === 'object' ? candidate.details : {});
})(); return {
    ...candidate,
    content: normalizedContent,
    details: details as Record<string, unknown>,
    ...(candidate.isError === undefined ? {} : { isError: Boolean(candidate.isError) }),
  } as ToolTextResult;
}

export function stringifyToolError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringifyToolText(text: unknown): string {
  if (typeof text === 'string') {
    return text;
  }
  if (text == null) {
    return '';
  }
  return String(text);
}
