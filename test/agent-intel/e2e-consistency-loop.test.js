const path = require('path'),
  fs = require('fs'),
  { execSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', '..', 'memory-store.js');

function run(cmd, timeout = 45000) {
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

describe('coding consistency loop — e2e', () => {
  const repoName = `test-e2e-loop-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/email.js': `
/**
 * Sends a verification email to a user.
 * Must use the centralized template system.
 */
function sendVerificationEmail(userId, token) {
  const template = loadTemplate('verification');
  const user = getUser(userId);
  return mailer.send(user.email, template.render({ token }));
}

function loadTemplate(name) {
  return templateStore.get(name);
}`,
      'src/user.js': `function getUser(id) { return db.query("SELECT * FROM users WHERE id = ?", [id]); }`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);
    run(
      `save --title "Email templates centralized" --content "**What**: All email templates must go through loadTemplate in src/email.js. **Why**: Centralized template management. **Where**: src/email.js" --type decision --project ${repoName}`,
    );
    run(`enrich-symbols --repo ${repoName}`);
    run(`dupes --repo ${repoName}`);
  }, 90000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('preflight warns about existing email code before creating new', () => {
    const result = run(`preflight --repo ${repoName} --task "send verification email"`);
    expect(result.error).toBeUndefined();
    // Should find the sendVerificationEmail symbol
    expect(result.likely_existing_code.some((c) => c.symbol === 'sendVerificationEmail')).toBe(true);
    // New field: structural_duplicates should be present
    expect(result).toHaveProperty('structural_duplicates');
    expect(Array.isArray(result.structural_duplicates)).toBe(true);
    // Risk should be medium or high since existing code matches
    expect(['medium', 'high']).toContain(result.risk);
  });

  it('audit-diff detects symbols in changed files', () => {
    const dupFile = path.join(tmpRepo, 'src', 'email-service.js'),
      result = (() => {
        fs.writeFileSync(
          dupFile,
          `
  function sendVerificationEmail(userId, token) {
    const tpl = getTemplate('verify');
    const user = findUser(userId);
    return sendMail(user.email, tpl.render({ token }));
  }`,
        );
        // Re-index to pick up the new file
        run(`index-repo --path "${tmpRepo}" --name ${repoName}`);

        return run(`audit-diff --repo ${repoName} --files src/email-service.js --task "send verification email"`);
      })();
    expect(result.error).toBeUndefined();
    expect(result).toHaveProperty('violations');
    expect(result.files_checked).toBe(1);

    try {
      fs.unlinkSync(dupFile);
    } catch {}
  });

  it('agent-pack includes relevant symbols and suggested plan', () => {
    const result = run(`agent-pack --repo ${repoName} --task "send verification email"`);
    expect(result.error).toBeUndefined();
    expect(result.relevant_symbols.length).toBeGreaterThan(0);
    expect(result.suggested_plan.length).toBeGreaterThan(0);
  });
});
