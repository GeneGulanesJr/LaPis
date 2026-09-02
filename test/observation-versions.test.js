const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { insertObservation, updateObservation } = require('../data-access/observations');
const { get } = require('../commands/observation');

describe('observation_versions table', () => {
  let deps, tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-observation-versions-'));
    db.resetDb();
    db.createDb({ db_path: path.join(tempDir, 'memory.db') });
    deps = {
      sqlJson: db.sqlJson,
      sqlRun: db.sqlRun,
    };
  });

  afterEach(() => {
    db.resetDb();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates observation_versions table after migration', () => {
    const tables = deps.sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_versions'");
    expect(tables).toHaveLength(1);
  });

  it('can insert and query a version record', () => {
    deps.sqlRun(
      `INSERT INTO observations (id, session_id, type, title, content, project, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [1, '1', 'decision', 'Memory 1', 'content', 'test', 'project'],
    );
    deps.sqlRun(
      "INSERT INTO observation_versions (memory_id, field, old_value, new_value) VALUES (1, 'content', 'old text', 'new text')",
    );
    const rows = deps.sqlJson('SELECT * FROM observation_versions WHERE memory_id = 1');
    expect(rows).toHaveLength(1);
    expect(rows[0].field).toBe('content');
    expect(rows[0].old_value).toBe('old text');
    expect(rows[0].new_value).toBe('new text');
  });
});

describe('updateObservation versioning', () => {
  let deps, tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-observation-versions-'));
    db.resetDb();
    db.createDb({ db_path: path.join(tempDir, 'memory.db') });
    deps = {
      sqlJson: db.sqlJson,
      sqlRun: db.sqlRun,
    };
  });

  afterEach(() => {
    db.resetDb();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records version entry when title is updated', () => {
    const inserted = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'Old title',
        content: 'content',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id = inserted[0].id,
    versions = (() => {

  
      updateObservation(deps, { id, title: 'New title' });
  
      
  return (deps.sqlJson('SELECT field, old_value, new_value FROM observation_versions WHERE memory_id = ?', [
      id,
    ]));
})();expect(versions).toHaveLength(1);
    expect(versions[0].field).toBe('title');
    expect(versions[0].old_value).toBe('Old title');
    expect(versions[0].new_value).toBe('New title');
  });

  it('records version entries for multiple changed fields', () => {
    const inserted = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'Old',
        content: 'old content',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id = inserted[0].id,
    versions = (() => {

  
      updateObservation(deps, { id, title: 'New', content: 'new content' });
  
      
  return (deps.sqlJson('SELECT field FROM observation_versions WHERE memory_id = ? ORDER BY field', [id]));
})();expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.field)).toEqual(['content', 'title']);
  });

  it('does not record version when nothing changes', () => {
    const inserted = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'Title',
        content: 'content',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id = inserted[0].id,
      result = updateObservation(deps, { id }),
    versions = (() => {

      expect(result).toBeNull();
  
      
  return (deps.sqlJson('SELECT * FROM observation_versions WHERE memory_id = ?', [id]));
})();expect(versions).toHaveLength(0);
  });
});

describe('memory-get includes version history', () => {
  let deps, tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-observation-versions-'));
    db.resetDb();
    db.createDb({ db_path: path.join(tempDir, 'memory.db') });
    deps = {
      sqlJson: db.sqlJson,
      sqlRun: db.sqlRun,
      jsonErrNoExit: (msg) => ({ error: msg }),
    };
  });

  afterEach(() => {
    db.resetDb();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty versions array for memory with no edits', () => {
    const inserted = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'Test',
        content: 'content',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id = inserted[0].id,
      result = get(deps, { id: String(id) });
    expect(result.versions).toEqual([]);
  });

  it('returns version entries after an update', () => {
    const inserted = insertObservation(deps, {
        sessionId: '1',
        type: 'decision',
        title: 'V1',
        content: 'content',
        project: 'test',
        scope: 'project',
        topicKey: null,
      }),
      id = inserted[0].id,
    result = (() => {

  
      updateObservation(deps, { id, title: 'V2' });
      
  return (get(deps, { id: String(id) }));
})();expect(result.versions).toHaveLength(1);
    expect(result.versions[0].field).toBe('title');
    expect(result.versions[0].old_value).toBe('V1');
    expect(result.versions[0].new_value).toBe('V2');
  });
});
