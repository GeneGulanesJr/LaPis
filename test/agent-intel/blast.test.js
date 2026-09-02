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

describe('blast command', () => {
  const repoName = `test-blast-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/core.js': `
export function criticalFunction() { return db.query("SELECT 1"); }
export function helper() { return "helper"; }
`,
      'src/handlers/api.js': `
import { criticalFunction } from '../core.js';
export function handleApi() { criticalFunction(); }
`,
      'src/handlers/admin.js': `
import { criticalFunction } from '../core.js';
export function handleAdmin() { criticalFunction(); }
`,
      'test/core.test.js': `
import { criticalFunction } from '../src/core.js';
test('core', () => { criticalFunction(); });
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

  it('returns blast radius for a symbol', () => {
    const result = run(`blast --repo ${repoName} --symbol criticalFunction`);
    expect(result.error).toBeUndefined();
    expect(result.symbol).toBe('criticalFunction');
    expect(result.direct_callers).toBeGreaterThanOrEqual(2);
    expect(['low', 'medium', 'high', 'critical']).toContain(result.risk);
  });

  it('returns error for non-existent symbol', () => {
    let result;
    try {
      result = run(`blast --repo ${repoName} --symbol NonExistentFunctionXYZ`);
      // If no error thrown, check result
      expect(result.error).toContain('not found');
    } catch (e) {
      // CLI may exit with error code
      const output = e.stderr || e.stdout || '{}';
      result = JSON.parse(output);
      expect(result.error).toContain('not found');
    }
  });
});
