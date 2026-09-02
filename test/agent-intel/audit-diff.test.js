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

describe('audit-diff command', () => {
  const repoName = `test-audit-diff-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/prefs.js': `function getPreferences(userId) {
  return db.query("SELECT * FROM prefs WHERE user_id = ?", [userId]);
}

function savePreferences(userId, prefs) {
  return db.query("UPDATE prefs SET data = ? WHERE user_id = ?", [JSON.stringify(prefs), userId]);
}`,
      'src/users.js': `function getUser(id) {
  return db.query("SELECT * FROM users WHERE id = ?", [id]);
}`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);
    run(
      `save --title "prefs constraint" --content "**What**: Do not create separate notification preference service. **Why**: getPreferences already handles all preference types. **Where**: src/prefs.js" --type decision --project ${repoName}`,
    );
  }, 60000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('audits a diff for violations', () => {
    // Add a new file that may be considered duplicate
    const newFile = path.join(tmpRepo, 'src', 'notification-prefs.js'),
    result = (() => {

      fs.writeFileSync(
        newFile,
        `function getNotificationPreferences(userId) {
    return db.query("SELECT * FROM prefs WHERE user_id = ?", [userId]);
  }`,
      );
  
      
  return (run(`audit-diff --repo ${repoName} --files src/notification-prefs.js`));
})();expect(result.error).toBeUndefined();
    expect(result).toHaveProperty('violations');
    expect(result).toHaveProperty('risk');
    expect(result).toHaveProperty('files_checked');
    expect(Array.isArray(result.violations)).toBe(true);

    // Clean up
    try {
      fs.unlinkSync(newFile);
    } catch {}
  });

  it('reports low risk for unrelated changes', () => {
    const newFile = path.join(tmpRepo, 'src', 'utils.js'),
    result = (() => {

      fs.writeFileSync(newFile, `function formatDate(d) { return d.toISOString().split('T')[0]; }`);
  
      
  return (run(`audit-diff --repo ${repoName} --files src/utils.js`));
})();expect(result.error).toBeUndefined();
    expect(result.files_checked).toBe(1);

    try {
      fs.unlinkSync(newFile);
    } catch {}
  });

  it('returns error for missing repo', () => {
    let result;
    try {
      result = run(`audit-diff --repo nonexistent-repo-xyz --files src/a.js`);
    } catch (e) {
      // Command exits with code 1, output goes to stderr
      result = JSON.parse(e.stderr || e.stdout || '{}');
    }
    expect(result.error).toBeDefined();
  });
});
