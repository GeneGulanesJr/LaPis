// Passive captures must not crowd hand-saved memories out of prompt recall,
// And the dream cleanup must reach every type they are saved as (#371).
const fs = require('node:fs'),
  path = require('node:path'),
  Database = require('better-sqlite3'),
  { context } = require('../src/memory-domain/context'),
  { dream } = require('../src/memory-domain/compaction');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  const insert = db.prepare(
    'INSERT INTO observations (session_id, title, content, type, project) VALUES (1, ?, ?, ?, ?)',
  );
  return {
    db,
    add: (title, content, type, project = 'p') => Number(insert.run(title, content, type, project).lastInsertRowid),
    deps: {
      sqlJson: (q, p) => db.prepare(q).all(...(p || [])),
      sqlRun: (q, p) => db.prepare(q).run(...(p || [])),
      jsonErrNoExit: (message) => ({ error: message }),
    },
  };
}

const AUTO = '**What**: Auto-detected bug fix (confidence: medium)\n**Learned**: login token login token expires';

describe('prompt recall ranks passive captures last', () => {
  test('a hand-saved match beats an auto-capture that matches more words', () => {
    const { add, deps } = makeDb();
    add('Bug fix: login token expires early', AUTO, 'bugfix');
    add('Token TTL decision', '**What**: login TTL set to one hour', 'decision');
    add('Other project: login token note', AUTO, 'bugfix', 'q');
    add('Other project: token rule', '**What**: login rule', 'decision', 'q');

    const out = context(deps, { project: 'p', query: 'login token', limit: '1' });

    expect(out.observations.map((o) => o.title)).toEqual(['Token TTL decision']);
    expect(out.cross_project_suggestions.map((o) => o.title)).toEqual([
      'Other project: token rule',
      'Other project: login token note',
    ]);
  });
});

describe('dream cleanup of passive captures', () => {
  test('removes an architecture capture and keeps a hand-saved memory that mentions Auto-detected', () => {
    const { add, deps } = makeDb(),
      deleted = [],
      capture = add('Constraint identified: x cannot run because y', AUTO, 'architecture'),
      handSaved = add('Endpoint note', '**What**: the probe reported Auto-detected values', 'decision');

    dream({ ...deps, softDeleteObservation: (id) => deleted.push(id) }, { bypassAgeGates: true });

    expect(deleted).toContain(capture);
    expect(deleted).not.toContain(handSaved);
  });
});
