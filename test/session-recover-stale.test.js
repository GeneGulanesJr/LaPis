// #391: session-start must not auto-recover (close) a session still running in another process.
const fs = require('fs'),
  path = require('path'),
  Database = require('better-sqlite3'),
  { sessionStart } = require('../src/memory-domain/sessions'),
  { recoverOrphans } = require('../services/recovery');

describe('auto-recover only stale sessions (#391)', () => {
  let db, deps;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    deps = {
      sqlJson: (q, p = []) => db.prepare(q).all(...p),
      withTransaction: (fn) => db.transaction(fn)(),
      autoRecoverInternal: vi.fn(),
      TOOL_TIERS: { full: null },
      commands: {},
    };
  });

  afterEach(() => db.close());

  const openSession = (startedAgo) =>
    db
      .prepare(`INSERT INTO session_log (project, started_at) VALUES ('p', datetime('now', ?)) RETURNING id`)
      .get(startedAgo).id;

  it('leaves a recently started session alone', () => {
    openSession('-10 minutes');
    const r = sessionStart(deps, { project: 'p' });
    expect(r.hasIncompletePreviousSession).toBe(false);
    expect(deps.autoRecoverInternal).not.toHaveBeenCalled();
  });

  it('leaves an old session alone while it still saves memories', () => {
    const id = openSession('-2 days');
    db.prepare(
      `INSERT INTO observations (session_id, type, title, content, project, created_at)
       VALUES (?, 'progress', 't', 'c', 'p', datetime('now', '-1 hour'))`,
    ).run(String(id));
    expect(sessionStart(deps, { project: 'p' }).hasIncompletePreviousSession).toBe(false);
  });

  it('recovers a session idle past the stale window', () => {
    const id = openSession('-7 hours'),
      r = sessionStart(deps, { project: 'p' });
    expect(r.incompleteSessionId).toBe(id);
    expect(deps.autoRecoverInternal).toHaveBeenCalledWith(String(id));
  });

  it('recover-orphans skips live sessions', () => {
    openSession('-10 minutes');
    expect(recoverOrphans({ sqlJson: deps.sqlJson, sqlRun: vi.fn() }).total).toBe(0);
  });
});
