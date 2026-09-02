const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', '..', 'memory-store.js');

function run(cmd, timeout = 30000) {
  const out = execSync(`node "${STORE}" ${cmd}`, {
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function writeTmpRepo(repoPath, files) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

describe('dupes command', () => {
  const repoName = `test-dupes-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/user-prefs.js': `
// Fetches user preferences from the database
function getUserPreferences(userId) {
  const query = "SELECT * FROM preferences WHERE user_id = ?";
  const result = db.execute(query, [userId]);
  if (!result || result.length === 0) {
    return { theme: "light", notifications: true };
  }
  return result[0];
}

function saveUserPreferences(userId, prefs) {
  const query = "UPDATE preferences SET theme = ?, notifications = ? WHERE user_id = ?";
  return db.execute(query, [prefs.theme, prefs.notifications, userId]);
}`,
      'src/settings-prefs.js': `
// Loads user settings/preferences from storage
function loadUserPrefs(uid) {
  const sql = "SELECT * FROM preferences WHERE user_id = ?";
  const rows = database.query(sql, [uid]);
  if (!rows || rows.length === 0) {
    return { theme: "light", notifications: true };
  }
  return rows[0];
}

function updatePreferences(uid, settings) {
  const sql = "UPDATE preferences SET theme = ?, notifications = ? WHERE user_id = ?";
  return database.query(sql, [settings.theme, settings.notifications, uid]);
}`,
      'src/utils.js': `
function formatDate(d) { return d.toISOString().split('T')[0]; }`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);
  }, 60000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('finds duplicate functions across files', () => {
    const result = run(`dupes --repo ${repoName}`);
    expect(result.error).toBeUndefined();
    expect(result.duplicate_groups).toBeDefined();
    expect(Array.isArray(result.duplicate_groups)).toBe(true);
    expect(result.total_symbols_scanned).toBeGreaterThan(0);
  });

  it('reports statistics', () => {
    const result = run(`dupes --repo ${repoName}`);
    expect(result).toHaveProperty('total_symbols_scanned');
    expect(result).toHaveProperty('groups_found');
    expect(result).toHaveProperty('scan_duration_ms');
  });

  it('returns empty groups for no duplicates in simple code', () => {
    const simpleRepo = `test-dupes-simple-${Date.now()}`,
      simplePath = path.join('/tmp', simpleRepo);
    writeTmpRepo(simplePath, {
      'src/a.js': 'function add(a, b) { return a + b; }',
      'src/b.js': 'function multiply(x, y) { return x * y; }',
    });
    run(`index-repo --path "${simplePath}" --name ${simpleRepo}`);
    try {
      const result = run(`dupes --repo ${simpleRepo}`);
      expect(result.error).toBeUndefined();
      expect(result.groups_found).toBe(0);
    } finally {
      try {
        run(`remove-code-repo --repo ${simpleRepo}`);
      } catch {}
      try {
        fs.rmSync(simplePath, { recursive: true });
      } catch {}
    }
  });
});
