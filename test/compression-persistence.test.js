// Regression tests for issue #284: compressMissionState computed the
// Compressed mission state and then discarded it — only summary/tokensSaved
// Were returned and persisted, so the feature stored nothing recoverable.
// Uses an isolated temp DB (LAPIS_HOME before any project module loads).
const os = require('node:os'),
  path = require('node:path'),
  fs = require('node:fs');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-compression-284-'));

const dbModule = require('../db'),
  { recordCompressionRun } = require('../src/compression/persistence');

beforeAll(() => {
  dbModule.ensureDb();
});

describe('mission compression persistence (#284)', () => {
  it('migration V26 adds the important_output column', () => {
    const version = dbModule.sqlJson('PRAGMA user_version')[0].user_version;
    expect(version).toBeGreaterThanOrEqual(26);
    const columns = dbModule.sqlJson('PRAGMA table_info(mission_compression_log)').map((c) => c.name);
    expect(columns).toContain('important_output');
  });

  it('recordCompressionRun persists the compressed state and it reads back', () => {
    dbModule.sqlRun("INSERT INTO missions (id, description, status) VALUES ('m-284', 'test mission', 'planning')");
    dbModule.sqlRun('DELETE FROM mission_compression_log WHERE mission_id = ?', ['m-284']);

    recordCompressionRun({
      missionId: 'm-284',
      trigger: 'manual',
      result: {
        summary: '3 sections compressed. Kept head (2 lines)…',
        compressed: '## Findings\nAuth uses JWT\n\n## Verdicts\n1 failed',
        tokensSaved: 123,
      },
    });

    const row = dbModule.sqlJson(
      'SELECT summary, tokens_saved, important_output, error FROM mission_compression_log WHERE mission_id = ?',
      ['m-284'],
    )[0];
    expect(row.summary).toContain('3 sections compressed');
    expect(row.tokens_saved).toBe(123);
    expect(row.important_output).toContain('Auth uses JWT');
    expect(row.error).toBeNull();
  });

  it('recordCompressionRun tolerates a missing compressed field (legacy callers)', () => {
    expect(() =>
      recordCompressionRun({ missionId: 'm-284', trigger: 'manual', result: { summary: 's', tokensSaved: 1 } }),
    ).not.toThrow();
    const row = dbModule.sqlJson(
      'SELECT important_output FROM mission_compression_log WHERE mission_id = ? ORDER BY id DESC LIMIT 1',
      ['m-284'],
    )[0];
    expect(row.important_output).toBeNull();
  });
});
