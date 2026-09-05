// Regression tests for issue #281: Dream Cycle phases that deleted live
// Memories. Runs against an isolated temp DB (LAPIS_HOME is set before any
// Project module loads) so real dream() runs never touch the user's DB.
const os = require('node:os'),
  path = require('node:path'),
  fs = require('node:fs');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-dream-guards-'));

const dbModule = require('../db'),
  { dream } = require('../src/memory-domain/compaction');

const PROJECT = 'dream-phase-guards';

function deps() {
  return {
    sqlJson: dbModule.sqlJson,
    sqlRun: dbModule.sqlRun,
    sqlRaw: dbModule.sqlRaw,
    jsonErrNoExit: dbModule.jsonErrNoExit,
    softDeleteObservation: (id) => {
      dbModule.sqlRun("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", [Number(id)]);
    },
  };
}

function seed({ title, type = 'decision', content = 'body', ageDays = 0 }) {
  const created = ageDays > 0 ? `datetime('now', '-${ageDays} days')` : "datetime('now')";
  return dbModule.sqlJson(
    `INSERT INTO observations (session_id, type, title, content, project, created_at)
     VALUES ('dream-test', ?, ?, ?, ?, ${created}) RETURNING id`,
    [type, title, content, PROJECT],
  )[0].id;
}

function relate(sourceId, targetId, relation, confidence) {
  dbModule.sqlRun(
    'INSERT INTO observation_relations (source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?)',
    [sourceId, targetId, relation, confidence],
  );
}

function softDelete(id) {
  dbModule.sqlRun("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", [id]);
}

function isDeleted(id) {
  return dbModule.sqlJson('SELECT deleted_at FROM observations WHERE id = ?', [id])[0].deleted_at !== null;
}

beforeAll(() => {
  dbModule.ensureDb();
});

describe('dream phase guards (#281)', () => {
  it('Phase 1: does not delete a superseded memory whose replacement is already gone', () => {
    const orphanedTarget = seed({ title: 'old decision, replacement purged' }),
      deadReplacement = seed({ title: 'newer decision, later deleted' });
    relate(deadReplacement, orphanedTarget, 'supersedes', 0.9);
    softDelete(deadReplacement);

    const liveTarget = seed({ title: 'old decision, replacement live' }),
      liveReplacement = seed({ title: 'newer decision, still live' });
    relate(liveReplacement, liveTarget, 'supersedes', 0.9);

    const report = dream(deps());

    expect(report.ok).toBe(true);
    expect(isDeleted(liveTarget)).toBe(true);
    expect(isDeleted(orphanedTarget)).toBe(false);
  });

  it('Phase 1: ignores duplicate/supersedes relations below the confidence threshold', () => {
    const target = seed({ title: 'decision with only an uncertain duplicate' }),
      source = seed({ title: 'uncertain duplicate source' });
    relate(source, target, 'duplicate', 0.3);

    dream(deps());

    expect(isDeleted(target)).toBe(false);
  });

  it('Phase 2: spares never-recalled progress memories younger than the age gate', () => {
    const young = seed({ title: 'progress written minutes ago', type: 'progress', ageDays: 0 }),
      old = seed({ title: 'progress written weeks ago', type: 'progress', ageDays: 30 });

    const report = dream(deps());

    expect(report.ok).toBe(true);
    expect(isDeleted(young)).toBe(false);
    expect(isDeleted(old)).toBe(true);
  });

  it('Phase 2: bypassAgeGates still deletes young progress', () => {
    const young = seed({ title: 'progress, gates bypassed', type: 'progress', ageDays: 0 });

    dream(deps(), { bypassAgeGates: true });

    expect(isDeleted(young)).toBe(true);
  });

  it('Phase 4: only deletes corrections past the age gate, not fresh ones', () => {
    const fresh = seed({ title: 'CORRECTION: written minutes ago', ageDays: 0 }),
      stale = seed({ title: 'CORRECTION: written weeks ago', ageDays: 30 });

    dream(deps());

    expect(isDeleted(fresh)).toBe(false);
    expect(isDeleted(stale)).toBe(true);
  });

  it('Phase 5: spares setup/decision memories targeted only by low-confidence relations', () => {
    const uncertain = seed({ title: 'setup decision, uncertain dupe', content: 'initial setup was replaced here' }),
      uncertainSource = seed({ title: 'uncertain source' });
    relate(uncertainSource, uncertain, 'duplicate', 0.2);

    const confident = seed({ title: 'setup decision, confident dupe', content: 'initial setup was replaced here' }),
      confidentSource = seed({ title: 'confident source' });
    relate(confidentSource, confident, 'supersedes', 0.9);

    dream(deps());

    expect(isDeleted(uncertain)).toBe(false);
    expect(isDeleted(confident)).toBe(true);
  });

  it('Phase 7: consolidation preserves the kept memory type instead of forcing decision', () => {
    const keep = seed({ title: 'bugfix one', type: 'bugfix', content: 't1' }),
      second = seed({ title: 'bugfix two', type: 'bugfix', content: 't2' }),
      third = seed({ title: 'bugfix three', type: 'bugfix', content: 't3' });
    for (const id of [keep, second, third]) {
      dbModule.sqlRun('UPDATE observations SET topic_key = ? WHERE id = ?', ['guard-topic-a', id]);
    }

    const report = dream(deps());

    expect(report.ok).toBe(true);
    const kept = dbModule.sqlJson('SELECT type, title, deleted_at FROM observations WHERE id = ?', [keep])[0];
    expect(kept.deleted_at).toBeNull();
    expect(kept.title).toContain('consolidated');
    expect(kept.type).toBe('bugfix');
    expect(isDeleted(second)).toBe(true);
    expect(isDeleted(third)).toBe(true);
  });
});
