// #388: pr-risk and audit-diff get repo-relative paths but the index stores absolute ones.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  Database = require('better-sqlite3'),
  { getPrRiskProfile } = require('../src/code-analysis/risk-impl'),
  { auditDiff } = require('../src/agent-intel/audit-diff');

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
}

describe('changed files map to indexed symbols (#388)', () => {
  let db, repoDir, repoId;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-388-'));
    fs.mkdirSync(path.join(repoDir, 'src'));
    git(repoDir, 'init', '-q', '-b', 'trunk');
    fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), 'function alpha() { return 1; }\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), 'function alpha() { return 2; }\n');
    git(repoDir, 'commit', '-q', '-am', 'two');

    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    repoId = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)').run('r388', repoDir).lastInsertRowid;
    const abs = path.join(repoDir, 'src', 'a.js'),
      fileId = db
        .prepare(
          "INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, 'javascript', '', 'h')",
        )
        .run(repoId, abs).lastInsertRowid;
    db.prepare(
      `INSERT INTO code_symbols (repo_id, file_id, name, kind, file_path, start_line, end_line, start_byte, end_byte, language, qualified_name)
       VALUES (?, ?, 'alpha', 'function', ?, 1, 1, 0, 30, 'javascript', 'alpha')`,
    ).run(repoId, fileId, abs);
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('pr-risk counts symbols in files from git diff', () => {
    const r = getPrRiskProfile(db, repoId, { base: 'HEAD~1', branch: 'HEAD' });
    expect(r.error).toBeUndefined();
    expect(r.changed_files).toBe(1);
    expect(r.changed_symbols).toBe(1);
  });

  it('pr-risk returns an error when git fails instead of "no changes"', () => {
    const r = getPrRiskProfile(db, repoId, { base: 'main', branch: 'HEAD' });
    expect(r.error).toMatch(/git diff main\.\.\.HEAD failed/);
  });

  it('audit-diff matches repo-relative --files', () => {
    const r = auditDiff(db, repoId, { files: ['src/a.js'] });
    expect(r.violations.some((v) => v.type === 'untested_public_api' && v.symbol === 'alpha')).toBe(true);
  });
});
