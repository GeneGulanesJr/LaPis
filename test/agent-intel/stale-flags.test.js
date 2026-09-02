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

describe('stale flags command', () => {
  const repoName = `test-stale-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/feature.js': `
// Stale: always-true condition
if (true) {
  console.log('always runs');
}

// Stale: feature flag never toggled
if (process.env.FEATURE_NEW_DASHBOARD === 'enabled') {
  renderNewDashboard();
} else {
  renderOldDashboard();
}

// Normal code
function normalFunc() { return true; }
`,
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

  it('detects stale flags in repository', () => {
    const result = run(`stale-flags --repo ${repoName}`);
    expect(result.error).toBeUndefined();
    expect(result.stale_flags.length).toBeGreaterThanOrEqual(1);
    expect(result.stale_flags.some((f) => f.branch_type === 'always-true')).toBe(true);
  });

  it('returns empty for clean repo', () => {
    // Create a clean repo
    const cleanRepoName = `test-clean-${Date.now()}`,
      cleanTmp = path.join('/tmp', cleanRepoName);
    writeTmpRepo(cleanTmp, { 'src/util.js': 'export function add(a, b) { return a + b; }' });
    run(`index-repo --path "${cleanTmp}" --name ${cleanRepoName}`);

    const result = run(`stale-flags --repo ${cleanRepoName}`);
    expect(result.stale_flags.length).toBe(0);

    try {
      run(`remove-code-repo --repo ${cleanRepoName}`);
    } catch {}
    try {
      fs.rmSync(cleanTmp, { recursive: true });
    } catch {}
  });
});
