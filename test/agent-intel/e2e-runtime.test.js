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

function writeCoverage(coveragePath, data) {
  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });
  fs.writeFileSync(coveragePath, JSON.stringify(data));
}

describe('runtime reality e2e', () => {
  const repoName = `test-e2e-runtime-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName),
    coveragePath = path.join(tmpRepo, 'coverage', 'coverage-final.json');

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/critical.js': `
export function processPayment(amount) {
  return db.query("INSERT INTO payments VALUES (?)", [amount]);
}`,
      'src/batch.js': `
import { processPayment } from './critical.js';
export function batchProcess(items) {
  return items.map(processPayment);
}`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);

    // Write coverage: processPayment is hot
    writeCoverage(coveragePath, {
      [`${tmpRepo}/src/critical.js`]: {
        path: `${tmpRepo}/src/critical.js`,
        fnMap: { 0: { name: 'processPayment', line: 1 } },
        f: { 0: 15000 }, // Hot
      },
    });

    // Ingest coverage
    run(`runtime-ingest --repo ${repoName} --coverage "${coveragePath}"`);
  }, 90000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('preflight shows runtime hotness for hot paths', () => {
    const result = run(`preflight --repo ${repoName} --task "process payment"`);
    expect(result.error).toBeUndefined();
    expect(result.runtime_hotness).not.toBeNull();
    expect(result.runtime_hotness.is_hot_path).toBe(true);
  });

  it('preflight upgrades risk for hot paths', () => {
    const result = run(`preflight --repo ${repoName} --task "process payment"`);
    // Hot path should upgrade risk
    expect(['medium', 'high']).toContain(result.risk);
  });

  it('blast command shows runtime data', () => {
    const result = run(`blast --repo ${repoName} --symbol processPayment`);
    expect(result.error).toBeUndefined();
    expect(result.runtime).not.toBeNull();
    expect(result.runtime.traffic).toBe('hot');
  });

  it('stale-flags command works', () => {
    // Add stale flag to repo
    const flagFile = path.join(tmpRepo, 'src', 'flags.js'),
      result = (() => {
        fs.writeFileSync(flagFile, `if (process.env.FEATURE_OLD_CODE === 'enabled') { legacy(); }`);
        run(`index-repo --path "${tmpRepo}" --name ${repoName}`);

        return run(`stale-flags --repo ${repoName}`);
      })();
    expect(result.stale_flags.length).toBeGreaterThanOrEqual(1);

    fs.unlinkSync(flagFile);
  });

  it('hot-symbols and cold-symbols commands work', () => {
    const hotResult = run(`hot-symbols --repo ${repoName}`),
      coldResult = (() => {
        expect(hotResult.error).toBeUndefined();
        expect(hotResult.hot_symbols.some((s) => s.function_name === 'processPayment')).toBe(true);

        return run(`cold-symbols --repo ${repoName}`);
      })();
    expect(coldResult.error).toBeUndefined();
  });
});
