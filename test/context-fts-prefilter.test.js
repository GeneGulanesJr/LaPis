// Prompt topic matching pre-filters with FTS instead of LIKE-scanning every row (#396).
const fs = require('node:fs'),
  path = require('node:path'),
  Database = require('better-sqlite3'),
  { context } = require('../src/memory-domain/context');

// Seeds [title, content, project?] rows into a schema.sql DB, runs context() and records every SQL it ran.
function run(rows, query) {
  const db = new Database(':memory:'),
    queries = [];
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  for (const [title, content, project = 'p'] of rows) {
    db.prepare('INSERT INTO observations (session_id, title, content, type, project) VALUES (1, ?, ?, ?, ?)').run(
      title,
      content,
      'decision',
      project,
    );
  }
  const deps = {
      sqlJson: (q, p) => {
        queries.push(q);
        return db.prepare(q).all(...(p || []));
      },
      jsonErrNoExit: (message) => ({ error: message }),
    },
    out = context(deps, { project: 'p', query });
  return {
    titles: out.observations.map((o) => o.title),
    cross: out.cross_project_suggestions.map((o) => o.title),
    topicScans: queries.filter((q) => q.includes('topic_matches')),
    crossScans: queries.filter((q) => q.includes('o.project != ?')),
  };
}

describe('context topic FTS prefilter', () => {
  test('a prompt matching a title or content word is served by the prefilter alone', () => {
    const r = run(
      [
        ['Auth tokens expire hourly', '**What**: refresh flow'],
        ['Unrelated note', '**What**: the database migration runs at boot'],
        ['Other project', '**What**: tokens elsewhere', 'q'],
      ],
      'why do tokens expire? and what about migration',
    );

    expect(r.titles.toSorted()).toEqual(['Auth tokens expire hourly', 'Unrelated note']);
    expect(r.cross).toEqual(['Other project']);
    expect(r.topicScans).toHaveLength(1);
    expect(r.topicScans[0]).toContain('observations_fts MATCH');
  });

  test('falls back to the full LIKE scan when FTS finds nothing', () => {
    const r = run([['Rebuild trigram overlap', '**What**: fixed']], 'igram');

    expect(r.titles).toEqual(['Rebuild trigram overlap']);
    expect(r.topicScans).toHaveLength(2);
    expect(r.topicScans[1]).not.toContain('observations_fts MATCH');
  });

  test('skips the cross-project full scan when FTS hits exist only in the current project', () => {
    const r = run(
      [
        ['Local note', '**What**: cache warmup'],
        ['Other project note', '**What**: unrelated', 'q'],
      ],
      'cache warmup',
    );

    expect(r.titles).toEqual(['Local note']);
    expect(r.cross).toEqual([]);
    expect(r.crossScans).toHaveLength(1);
    expect(r.crossScans[0]).toContain('observations_fts MATCH');
  });

  // A MATCH syntax error would fall back to a second, unfiltered scan.
  test.each([
    'say "hello" NEAR(foo bar) OR -baz* title:qux AND NOT ^x',
    "it's {title} : ( ) \" ' * - + % _ \\ ;",
    'NEAR OR AND NOT',
  ])('FTS-special prompt %j stays on the prefilter', (query) => {
    const r = run([['Hello world near foo', '**What**: bar baz qux title']], query);

    expect(r.titles).toEqual(['Hello world near foo']);
    expect(r.topicScans).toHaveLength(1);
    expect(r.topicScans[0]).toContain('observations_fts MATCH');
  });
});
