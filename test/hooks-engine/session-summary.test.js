const { buildSessionSummary } = require('../../src/hooks-engine/session-summary');

describe('hooks-engine session-summary: buildSessionSummary', () => {
  const userMessages = [
    { message: { role: 'user', content: [{ type: 'text', text: 'How do I configure the DB?' }] } },
    { message: { role: 'user', content: [{ type: 'text', text: 'Now add a migration step.' }] } },
  ];

  test('renders Goal, Topics, Accomplished sections', () => {
    const out = buildSessionSummary({
      userMessages,
      assistantCount: 3,
      turnCount: 12,
      memoriesSaved: 2,
      editedFiles: [],
      cwd: process.cwd(),
    });
    expect(out).toContain('## Goal');
    expect(out).toContain('How do I configure the DB?');
    expect(out).toContain('## Topics Discussed');
    expect(out).toContain('- How do I configure the DB');
    expect(out).toContain('## Accomplished');
    expect(out).toContain('2 memories saved, 3 assistant turns, 12 total turns');
  });

  test('includes Files Modified section when files present', () => {
    const out = buildSessionSummary({
      userMessages,
      assistantCount: 1,
      turnCount: 1,
      memoriesSaved: 0,
      editedFiles: new Set(['/tmp/repo/src/a.js']),
      cwd: '/tmp/repo',
    });
    expect(out).toContain('## Files Modified');
    expect(out).toContain('src/a.js');
  });

  test('falls back to "Session work" when no user messages', () => {
    const out = buildSessionSummary({
      userMessages: [],
      assistantCount: 0,
      turnCount: 0,
      memoriesSaved: 0,
      editedFiles: [],
      cwd: process.cwd(),
    });
    expect(out).toContain('## Goal');
    expect(out).toContain('Session work');
  });

  test('accepts array or Set for editedFiles', () => {
    const a = buildSessionSummary({
      userMessages: [],
      assistantCount: 0,
      turnCount: 0,
      memoriesSaved: 0,
      editedFiles: ['/x/a.js'],
      cwd: '/',
    });
    expect(a).toContain('## Files Modified');
  });
});
