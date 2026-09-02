'use strict';

/**
 * Hooks-engine: prompt-classifiers
 *
 * Pure prompt/message classifiers extracted from
 * extensions/memory-layer/hooks/context-injection.ts (extractUserPrompt,
 * contentToText, is*Prompt classifiers) plus the extractMessageText helper that
 * was duplicated in passive-capture.ts and session-lifecycle.ts.
 */

function contentToText(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
    return text || null;
  }

  return null;
}

function extractUserPrompt(event) {
  const eventAny = event,
    candidates = [eventAny?.prompt, eventAny?.input, eventAny?.query],
    messages = Array.isArray(eventAny?.messages) ? eventAny.messages : [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') {
      candidates.push(message.content);
      break;
    }
  }

  for (const candidate of candidates) {
    const text = contentToText(candidate);
    if (text) {
      return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    }
  }

  return null;
}

function isSourceAuthoritativePrompt(prompt) {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return (
    /\bcurrent source\b/.test(normalized) ||
    /\bcurrent code\b/.test(normalized) ||
    /\bfrom the code\b/.test(normalized) ||
    /\banswer from (?:the )?code\b/.test(normalized)
  );
}

function isHistoricalMemoryPrompt(prompt) {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return (
    /\bwhy did\b/.test(normalized) ||
    /\bwhat bug led to\b/.test(normalized) ||
    /\brationale\b/.test(normalized) ||
    /\bdecision\b/.test(normalized) ||
    /\bchoose\b/.test(normalized) ||
    /\bchose\b/.test(normalized)
  );
}

function isNavigationPrompt(prompt) {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return (
    /\b(where|module|file|hook|wired|location|path|lives|implemented|implementation|identify)\b/.test(normalized) ||
    /\bcurrent\s+\w*\s*module\b/.test(normalized)
  );
}

function isPreflightWorthyPrompt(prompt) {
  if (!prompt) {
    return false;
  }
  // Skip prompts that are purely questions/navigation/history
  if (isSourceAuthoritativePrompt(prompt) || isHistoricalMemoryPrompt(prompt) || isNavigationPrompt(prompt)) {
    return false;
  }
  const normalized = prompt.toLowerCase();
  // Heavily question-shaped prompts (starts with question words and no action verbs)
  if (/^(what|where|when|who|how many|does|is there|can you explain|tell me about)\b/.test(normalized)) {
    return false;
  }
  // Must contain at least one action/coding signal
  const codingSignals = [
    /\b(add|create|build|implement|fix|refactor|modify|update|change|remove|delete)\b/,
    /\b(write|extend|extract|move|rename|migrate|wire up|integrate)\b/,
    /\b(feature|bug|issue|test|function|module|component|endpoint|route)\b/,
    /\b(make it|ensure|so that|need to|should|let's|let me)\b/,
  ];
  return codingSignals.some((re) => re.test(normalized));
}

/**
 * Extract plain text from a Pi message object (string content or text content-parts).
 * De-duplicated from passive-capture.ts and session-lifecycle.ts.
 */
function extractMessageText(msg) {
  if (!msg) {
    return '';
  }
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join(' ');
  }
  return '';
}

module.exports = {
  contentToText,
  extractUserPrompt,
  isSourceAuthoritativePrompt,
  isHistoricalMemoryPrompt,
  isNavigationPrompt,
  isPreflightWorthyPrompt,
  extractMessageText,
};
