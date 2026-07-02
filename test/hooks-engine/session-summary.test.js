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

  test('Goal line reads string content (Claude Code transcript shape), not just content-block arrays', () => {
    // Claude Code transcripts carry user messages as { message: { role, content: '<string>' } }.
    // The Goal line previously used `.content[0].text`, which for a string returned the first
    // CHARACTER and fell back to "Session work" — losing the goal for every Claude Code session.
    const stringContentMessages = [{ message: { role: 'user', content: 'Fix the login bug in auth.ts' } }];
    const out = buildSessionSummary({
      userMessages: stringContentMessages,
      assistantCount: 1,
      turnCount: 1,
      memoriesSaved: 0,
      editedFiles: [],
      cwd: process.cwd(),
    });
    expect(out).toContain('## Goal');
    expect(out).toContain('Fix the login bug in auth.ts');
    expect(out).not.toContain('Session work');
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

  test('dedupes dual full-path + basename editedFiles entries', () => {
    const out = buildSessionSummary({
      userMessages: [],
      assistantCount: 0,
      turnCount: 0,
      memoriesSaved: 0,
      editedFiles: ['/tmp/repo/src/a.js', 'a.js', '/tmp/repo/lib/b.ts', 'b.ts'],
      cwd: '/tmp/repo',
    });
    expect(out).toContain('- src/a.js');
    expect(out).toContain('- lib/b.ts');
    expect(out.match(/- src\/a\.js/g)).toHaveLength(1);
    expect(out.match(/- lib\/b\.ts/g)).toHaveLength(1);
  });
});
