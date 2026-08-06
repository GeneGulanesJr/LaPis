const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const STORE = path.resolve(__dirname, '..', '..', 'memory-store.js');

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

describe('symbol enrichment', () => {
  const repoName = `test-enrich-${Date.now()}`;
  const tmpRepo = path.join('/tmp', repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/users.js': `
/**
 * Validates a user email address.
 * Must not accept null or undefined — returns false instead.
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

// Do not use this for admin users — use validateAdminEmail instead
function sendWelcomeEmail(user) {
  const email = user.email;
  validateEmail(email);
  return mailer.send(email, 'Welcome');
}`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);
  }, 45000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('enriches symbols with intent from docstring and name', () => {
    const result = run(`enrich-symbols --repo ${repoName}`);
    expect(result.error).toBeUndefined();
    expect(result.enriched_count).toBeGreaterThan(0);
  });

  it('stores enriched data in symbol_metadata table', () => {
    run(`enrich-symbols --repo ${repoName}`);
    const symbols = run(`search-code --repo ${repoName} --query "validateEmail"`);
    expect(symbols.results.length).toBeGreaterThan(0);
    // Look up the symbol by name and file to get its DB id
    const sym = symbols.results[0];
    // outline the file to get symbol IDs
    const outline = run(`outline --repo ${repoName} --file ${sym.file}`);
    const match =
      outline.files?.[0]?.classes?.[0]?.methods?.find((m) => m.name === sym.symbol) ||
      outline.files?.[0]?.standalone?.find((s) => s.name === sym.symbol);
    if (match && match.id) {
      const meta = run(`symbol-meta --symbol-id ${match.id}`);
      expect(meta).not.toBeNull();
      expect(meta.intent).toBeDefined();
      expect(typeof meta.intent).toBe('string');
      expect(meta.intent.length).toBeGreaterThan(0);
    }
  });

  it('reports enrichment statistics', () => {
    const result = run(`enrich-symbols --repo ${repoName}`);
    expect(result).toHaveProperty('total_symbols');
    expect(result).toHaveProperty('enriched_count');
    expect(result).toHaveProperty('skipped_count');
    expect(result.total_symbols).toBeGreaterThan(0);
  });
});
