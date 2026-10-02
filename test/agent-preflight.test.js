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

function run(cmd, timeout = 30000) {
  const out = execFileSync(process.execPath, [STORE, ...tokenize(cmd)], {
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

describe('agent intelligence preflight', () => {
  const repoName = `test-agent-preflight-${Date.now()}`,
    tmpRepo = path.join(os.tmpdir(), repoName);

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/preferences.js': `export function getNotificationPreferences(userId) {
  return { userId, email: true, sms: false };
}

export function saveNotificationPreferences(userId, preferences) {
  return { userId, ...preferences };
}`,
      'test/preferences.test.js': `import { getNotificationPreferences } from '../src/preferences.js';

test('loads notification preferences', () => {
  expect(getNotificationPreferences('u1').email).toBe(true);
});`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);
    run(
      `save --title "Add notification preferences decision" --content "**What**: Add notification preferences by extending src/preferences.js **Why**: Avoid duplicate services" --type decision --project ${repoName}`,
    );
  }, 45000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('returns code, memory, related files, and duplicate warnings before coding', () => {
    const result = run(`preflight --repo ${repoName} --task "add notification preferences"`);

    expect(result.error).toBeUndefined();
    expect(result.task_summary).toBe('add notification preferences');
    expect(result.repo).toBe(repoName);
    expect(result.likely_existing_code.some((item) => item.symbol === 'getNotificationPreferences')).toBe(true);
    expect(result.similar_past_tasks.some((item) => item.title === 'Add notification preferences decision')).toBe(true);
    expect(result.related_files.some((file) => file.includes('preferences.js'))).toBe(true);
    expect(result.duplicate_warnings.length).toBeGreaterThan(0);
    expect(['medium', 'high']).toContain(result.risk);
  });

  it('accepts a positional task for the CLI shorthand', () => {
    const result = run(`preflight --repo ${repoName} "add notification preferences"`);

    expect(result.error).toBeUndefined();
    expect(result.task_summary).toBe('add notification preferences');
    expect(result.likely_existing_code.some((item) => item.symbol === 'getNotificationPreferences')).toBe(true);
  });

  it('builds a compact agent pack for Pi planning', () => {
    const result = run(`agent-pack --repo ${repoName} --task "add notification preferences"`);

    expect(result.error).toBeUndefined();
    expect(result.must_read.some((file) => file.includes('preferences.js'))).toBe(true);
    expect(result.relevant_symbols.some((item) => item.symbol === 'getNotificationPreferences')).toBe(true);
    expect(result.past_decisions.some((item) => item.title === 'Add notification preferences decision')).toBe(true);
    expect(result.suggested_plan.length).toBeGreaterThan(0);
    expect(result.recommended_action).toContain('NotificationPreferences');
  });
});
