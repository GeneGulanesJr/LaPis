const path = require('path'),
  os = require('os'),
  fs = require('fs'),
  { execFileSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js');

// Split a CLI command string into argv honoring quotes — the child is spawned
// directly (no shell), so argument quoting must not depend on the platform.
function tokenize(s) {
  const out = [];
  // Double-quoted tokens honor backslash-escaped quotes, matching the
  // shell-quoting convention callers use when embedding quotes in values.
  for (const m of s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\"/g, '"'));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3]);
  }
  return out;
}

function run(cmd, timeout = 45000) {
  const out = execFileSync(process.execPath, [STORE, ...tokenize(cmd)], {
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function unwrap(result) {
  return result && result.data ? result.data : result;
}

// Stored/indexed paths render with the platform separator; assertions target
// the POSIX spelling.
const toPosix = (p) => String(p).replace(/\\/g, '/');

function writeTmpRepo(repoPath, files) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

describe('coding-context command', () => {
  const repoName = `test-coding-context-${Date.now()}`,
    tmpRepo = path.join(os.tmpdir(), repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/users.js': `
export function validateUser(input) {
  return Boolean(input && input.id);
}

export function saveUser(input) {
  if (!validateUser(input)) throw new Error('missing id');
  return { id: input.id, saved: true };
}
`,
      'src/routes.js': `
import { saveUser } from './users.js';

export function createUserRoute(req) {
  return saveUser(req.body);
}
`,
      'test/users.test.js': `
import { saveUser } from '../src/users.js';

test('saves a user', () => {
  expect(saveUser({ id: 'u1' }).saved).toBe(true);
});
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

  it('builds a unified context packet for a symbol', () => {
    const result = unwrap(run(`coding-context --repo ${repoName} --symbol saveUser --depth 2 --top 5`));

    expect(result.error).toBeUndefined();
    expect(result.repo).toBe(repoName);
    expect(result.target.symbol).toBe('saveUser');
    expect(result.target.file && toPosix(result.target.file)).toContain('src/users.js');
    expect(result.summary).toBeTruthy();
    expect(['low', 'medium', 'high']).toContain(result.summary.risk);
    expect(Array.isArray(result.related_files)).toBe(true);
    expect(result.related_files.some((file) => toPosix(file).includes('src/users.js'))).toBe(true);
    expect(result.likely_tests.some((testFile) => toPosix(testFile.file).includes('test/users.test.js'))).toBe(true);
    expect(result.outline).toBeTruthy();
    expect(result.callers).toBeTruthy();
    expect(result.callees).toBeTruthy();
  });

  it('builds context for a file when no symbol is provided', () => {
    const result = unwrap(run(`coding-context --repo ${repoName} --file src/users.js --top 5`));

    expect(result.error).toBeUndefined();
    expect(result.target.file && toPosix(result.target.file)).toContain('src/users.js');
    expect(Array.isArray(result.target.symbols)).toBe(true);
    expect(result.target.symbols.some((sym) => sym.symbol === 'saveUser')).toBe(true);
    expect(result.outline).toBeTruthy();
    expect(result.deps).toBeTruthy();
    expect(result.likely_tests.some((testFile) => toPosix(testFile.file).includes('test/users.test.js'))).toBe(true);
  });
});
