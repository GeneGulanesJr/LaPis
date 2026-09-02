const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  {
    readTranscript,
    parseTranscriptLine,
    readTranscriptStream,
  } = require('../../../src/claude-code/hooks-engine/transcript-reader');

function writeTranscript(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-tx-')), 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

describe('claude-code transcript-reader', () => {
  test('parseTranscriptLine tolerates blank / malformed lines', () => {
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('   ')).toBeNull();
    expect(parseTranscriptLine('{ broken')).toBeNull();
    expect(parseTranscriptLine('"just a string"')).toBeNull();
    expect(parseTranscriptLine('{"role":"user"}').role).toBe('user');
  });

  test('reads a well-formed transcript into the summary shape', () => {
    const file = writeTranscript([
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'How does dispatch work?' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'It routes via gateway.' } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Thanks.' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'You are welcome.' }] },
        }),
      ]),
      summary = readTranscript(file);
    expect(summary.userMessages).toHaveLength(2);
    expect(summary.assistantMessageCount).toBe(2);
    expect(summary.lastAssistantText).toBe('You are welcome.');
  });

  test('tolerates blank lines, malformed lines, and unknown shapes', () => {
    const file = writeTranscript([
        '',
        '{ not json',
        JSON.stringify({ type: 'unknown', message: { role: 'system' } }),
        JSON.stringify({ message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ message: { role: 'assistant', content: 'world' } }),
        '   ',
      ]),
      summary = readTranscript(file);
    expect(summary.userMessages).toHaveLength(1);
    expect(summary.assistantMessageCount).toBe(1);
    expect(summary.lastAssistantText).toBe('world');
  });

  test('returns empty summary for a missing/absent path', () => {
    const summary = readTranscript('/does/not/exist.jsonl');
    expect(summary.userMessages).toEqual([]);
    expect(summary.assistantMessageCount).toBe(0);
    expect(summary.lastAssistantText).toBeNull();
  });

  test('readTranscriptStream matches readTranscript for the same input', async () => {
    const file = writeTranscript([
        JSON.stringify({ message: { role: 'user', content: 'q' } }),
        JSON.stringify({ message: { role: 'assistant', content: 'a' } }),
      ]),
      a = readTranscript(file),
      b = await readTranscriptStream(file);
    expect(b.userMessages).toHaveLength(a.userMessages.length);
    expect(b.assistantMessageCount).toBe(a.assistantMessageCount);
    expect(b.lastAssistantText).toBe(a.lastAssistantText);
  });
});
