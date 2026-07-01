'use strict';

/**
 * Claude Code bridge: transcript reader.
 *
 * Claude Code has no sessionManager.getEntries(); SessionEnd hands us a
 * `transcript_path` pointing at a .jsonl file of entries. This module parses
 * it into the shape session-summary.js consumes: { userMessages,
 * assistantMessageCount, lastAssistantText }.
 *
 * Streaming + tolerant: unknown/partial line shapes and malformed JSON lines
 * are skipped, never thrown.
 */

const fs = require('node:fs');
const readline = require('node:readline');
const { extractMessageText } = require('../../hooks-engine/prompt-classifiers');

/**
 * Parse a single transcript line into an entry object, or null if it isn't a
 * usable record. Tolerant of malformed JSON and non-object shapes.
 */
function parseTranscriptLine(line) {
  if (!line || typeof line !== 'string') {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  return obj;
}

/**
 * Reduce a parsed entry into the transcript summary accumulator. Mutates acc.
 */
function classifyEntry(entry, acc) {
  // Claude Code transcript entries are typically { type: 'user'|'assistant',
  // message: { role, content } } but may also carry role at the top level.
  const message = entry.message || null;
  const role = message?.role || entry.role;
  if (!role) {
    return;
  }

  if (role === 'user') {
    const text = extractMessageText(message);
    if (text && text.trim()) {
      acc.userMessages.push({ message });
    }
    return;
  }

  if (role === 'assistant') {
    acc.assistantMessageCount++;
    const text = extractMessageText(message);
    if (text && text.trim()) {
      acc.lastAssistantText = text;
    }
  }
}

/**
 * Read a Claude Code transcript_path (.jsonl) into a summary shape.
 *
 * @param {string} transcriptPath
 * @returns {{ userMessages: Array, assistantMessageCount: number, lastAssistantText: string|null }}
 */
function readTranscript(transcriptPath) {
  const acc = { userMessages: [], assistantMessageCount: 0, lastAssistantText: null };
  if (!transcriptPath) {
    return acc;
  }

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return acc;
  }

  for (const line of raw.split(/\r?\n/)) {
    const entry = parseTranscriptLine(line);
    if (entry) {
      classifyEntry(entry, acc);
    }
  }

  return acc;
}

/**
 * Streaming variant for large transcripts. Reads line-by-line via readline.
 * Resolves with the same summary shape as readTranscript.
 */
async function readTranscriptStream(transcriptPath) {
  const acc = { userMessages: [], assistantMessageCount: 0, lastAssistantText: null };
  if (!transcriptPath) {
    return acc;
  }

  let stream;
  try {
    stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  } catch {
    return acc;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const entry = parseTranscriptLine(line);
    if (entry) {
      classifyEntry(entry, acc);
    }
  }
  return acc;
}

module.exports = { readTranscript, readTranscriptStream, parseTranscriptLine, classifyEntry };
