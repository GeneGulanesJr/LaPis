const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkpointWal } = require('../src/memory-domain/compaction');

function tmpDbPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-wal-')), name);
}

describe('checkpointWal', () => {
  let sqlRaw;
  beforeEach(() => {
    sqlRaw = vi.fn();
  });

  it('skips when deps have no sqlRaw', () => {
    const report = checkpointWal({}, { dbPath: tmpDbPath('a.db') });
    expect(report.attempted).toBe(false);
    expect(report.skipped).toBe('no-sqlRaw');
  });

  it('skips when no WAL file exists', () => {
    const report = checkpointWal({ sqlRaw }, { dbPath: tmpDbPath('missing.db') });
    expect(report.attempted).toBe(false);
    expect(report.skipped).toBe('no-wal');
  });

  it('skips WALs at or below the size threshold without touching the DB', () => {
    const dbPath = tmpDbPath('small.db');
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(1024));
    const report = checkpointWal({ sqlRaw }, { dbPath, thresholdBytes: 4096 });
    expect(report.skipped).toBe('below-threshold');
    expect(report.walBytes).toBe(1024);
    expect(sqlRaw).not.toHaveBeenCalled();
  });

  it('runs a bounded TRUNCATE checkpoint above the threshold and restores busy_timeout', () => {
    const dbPath = tmpDbPath('big.db');
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(8192));
    const report = checkpointWal({ sqlRaw }, { dbPath, thresholdBytes: 4096 });
    expect(report.attempted).toBe(true);
    expect(report.truncated).toBe(true);
    const sqls = sqlRaw.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe('PRAGMA busy_timeout = 1000');
    expect(sqls[1]).toBe('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(sqls[2]).toMatch(/PRAGMA busy_timeout = \d+/);
    expect(sqls[2]).not.toBe('PRAGMA busy_timeout = 1000');
    expect(report.walBytesAfter).toBe(8192); // stat'ed after (no real sqlite here)
  });

  it('honors busyTimeoutMs override and reports checkpoint failure without throwing', () => {
    const dbPath = tmpDbPath('busy.db');
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(8192));
    sqlRaw.mockImplementation((sql) => {
      if (sql === 'PRAGMA wal_checkpoint(TRUNCATE)') throw new Error('database is locked');
    });
    const report = checkpointWal({ sqlRaw }, { dbPath, thresholdBytes: 4096, busyTimeoutMs: 250 });
    expect(report.truncated).toBe(false);
    expect(report.error).toBe('database is locked');
    const sqls = sqlRaw.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('PRAGMA busy_timeout = 250');
    // busy_timeout is restored even when the checkpoint fails
    expect(sqls[sqls.length - 1]).toMatch(/PRAGMA busy_timeout = (?!250\b)\d+/);
  });
});
