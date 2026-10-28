// Regression tests for audit findings 1, 2, 14 and 16 (memory data loss).
// LAPIS_HOME is a fresh temp dir per file (test/setup-lapis-home.js), so the
// Real gateway, db.js and dream() never touch the user's DB.
const { dispatch } = require('../src/cli/gateway'),
  db = require('../db'),
  { handlePostToolUse } = require('../src/claude-code/handlers/post-tool-use'),
  { tools } = require('../src/mcp/tools');

const AUTO = '**What**: Auto-detected decision (confidence: high)\n**Where**: Session 1\n**Learned**: ';

function isDeleted(id) {
  return db.sqlJson('SELECT deleted_at FROM observations WHERE id = ?', [id])[0].deleted_at !== null;
}

function mcpCommand(name, params, project) {
  return tools.find((t) => t.name === name).toCommand(params, { project });
}

describe('audit #1: a Claude Code memory-get keeps auto-detected memories alive through Dream', () => {
  it('records a useful recall for the fetched memory and Dream keeps it', async () => {
    const saved = await dispatch('save', {
        title: 'Decision: route all writes through the daemon',
        type: 'decision',
        project: 'a1',
        content: `${AUTO}route all writes through the daemon`,
      }),
      session = await dispatch('session-start', { project: 'a1' });
    db.sqlRun("UPDATE observations SET created_at = datetime('now', '-8 days') WHERE id = ?", [saved.id]);

    let state = { sessionId: session.sessionId, pendingRecallFeedback: [[saved.id, { sessionId: 1, query: 'q' }]] };
    await handlePostToolUse({
      payload: {
        session_id: 'claude-1',
        tool_name: 'mcp__lapis__memory-get',
        tool_input: { id: saved.id },
        tool_response: `## #${saved.id} — Decision`,
        cwd: process.cwd(),
      },
      dispatch,
      getKnownRepos: () => [],
      getKnownProjects: () => [],
      stateStore: {
        loadState: () => state,
        saveState: (_id, next) => {
          state = next;
        },
      },
    });

    expect(db.sqlJson('SELECT was_useful FROM recall_log WHERE memory_id = ?', [saved.id])).toEqual([
      { was_useful: 1 },
    ]);
    await dispatch('dream', {});
    expect(isDeleted(saved.id)).toBe(false);
  });
});

describe('audit #2: saving a similar-titled memory never deletes the other one', () => {
  it('returns potential_duplicate and keeps the first bugfix', async () => {
    const first = await dispatch('save', {
        title: 'Bugfix: Windows path normalization in hooks/pre-tool-use.js',
        content: 'pre-tool-use: use path.win32.normalize before matching',
        type: 'bugfix',
        project: 'a2',
      }),
      second = await dispatch('save', {
        title: 'Bugfix: Windows path normalization in hooks/post-tool-use.js',
        content: 'post-tool-use: lowercase drive letter before Set lookup',
        type: 'bugfix',
        project: 'a2',
      });
    expect(second.status).toBe('potential_duplicate');
    expect(isDeleted(first.id)).toBe(false);
  });
});

describe('audit #14: stale trust decays per day, not per session', () => {
  it('14 session start/end pairs in one day decay trust once', async () => {
    const saved = await dispatch('save', {
      title: 'Architecture: db.js owns migrations',
      type: 'architecture',
      project: 'a14',
      content: 'x',
      force: 'true',
    });
    db.sqlRun("UPDATE observations SET updated_at = datetime('now', '-100 days') WHERE id = ?", [saved.id]);
    db.sqlRun(
      "INSERT INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, 'runMigrations', 'LaPis', 1.0)",
      [String(saved.id)],
    );
    // Earlier tests in this file already ran today's decay (dream / session-end).
    db.sqlRun("DELETE FROM settings WHERE key = 'trust_decay_last'");
    for (let i = 0; i < 14; i++) {
      const s = await dispatch('session-start', { project: 'a14' });
      await dispatch('session-end', { id: String(s.sessionId) });
    }
    const [{ trust_score: trust }] = db.sqlJson('SELECT trust_score FROM symbol_links WHERE memory_id = ?', [
      String(saved.id),
    ]);
    expect(trust).toBeCloseTo(0.95, 5);
  });
});

describe('audit #16: MCP get/update/delete refuse another project memory unless allowed', () => {
  it('blocks cross-project get, update and delete; allow_cross_project opts in', async () => {
    const other = await dispatch('save', { title: 'Other project note', type: 'decision', project: 'b', content: 'c' });

    for (const [name, params] of [
      ['memory-get', { id: other.id }],
      ['memory-update', { id: other.id, title: 'overwritten' }],
      ['memory-delete', { id: other.id }],
    ]) {
      const { cmd, args } = mcpCommand(name, params, 'a16'),
        result = await dispatch(cmd, args);
      expect(result.error, name).toMatch(/belongs to project "b"/);
    }
    expect(db.sqlJson('SELECT title, deleted_at FROM observations WHERE id = ?', [other.id])).toEqual([
      { title: 'Other project note', deleted_at: null },
    ]);

    const { cmd, args } = mcpCommand('memory-get', { id: other.id, allow_cross_project: true }, 'a16');
    expect((await dispatch(cmd, args)).title).toBe('Other project note');
    // Same-project and CLI calls (no current project) are unaffected.
    expect((await dispatch('get', { id: String(other.id) })).title).toBe('Other project note');
    const same = mcpCommand('memory-get', { id: other.id }, 'b');
    expect((await dispatch(same.cmd, same.args)).title).toBe('Other project note');
  });
});
