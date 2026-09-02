const path = require('path'), fs = require('fs'), { execSync } = require('child_process'),
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

function writeCoverage(coveragePath, data) {
  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });
  fs.writeFileSync(coveragePath, JSON.stringify(data));
}

describe('runtime ingest command', () => {
  const repoName = `test-runtime-${Date.now()}`,
    tmpRepo = path.join('/tmp', repoName),
    coveragePath = path.join(tmpRepo, 'coverage', 'coverage-final.json');

  beforeAll(() => {
    writeTmpRepo(tmpRepo, {
      'src/api/users.js': `
export function getUser(id) { return db.query("SELECT * FROM users WHERE id = ?", [id]); }
export function listUsers() { return db.query("SELECT * FROM users"); }
export function createUser(data) { return db.query("INSERT INTO users SET ?", [data]); }
`,
    });
    run(`index-repo --path "${tmpRepo}" --name ${repoName}`);

    // Write Istanbul coverage
    writeCoverage(coveragePath, {
      [`${tmpRepo}/src/api/users.js`]: {
        path: `${tmpRepo}/src/api/users.js`,
        fnMap: {
          0: { name: 'getUser', line: 1 },
          1: { name: 'listUsers', line: 2 },
          2: { name: 'createUser', line: 3 },
        },
        f: { 0: 5000, 1: 150, 2: 50 }, // GetUser=hot, listUsers=warm, createUser=cold
      },
    });
  }, 60000);

  afterAll(() => {
    try {
      run(`remove-code-repo --repo ${repoName}`);
    } catch {}
    try {
      fs.rmSync(tmpRepo, { recursive: true });
    } catch {}
  });

  it('ingests Istanbul coverage JSON and classifies traffic', () => {
    const result = run(`runtime-ingest --repo ${repoName} --coverage "${coveragePath}"`);
    expect(result.error).toBeUndefined();
    expect(result.functions_ingested).toBe(3);
    expect(result.traffic_breakdown.hot).toBe(1);
    expect(result.traffic_breakdown.warm).toBe(1);
    expect(result.traffic_breakdown.cold).toBe(1);
  });

  it('returns hot symbols via hot-symbols command', () => {
    const result = run(`hot-symbols --repo ${repoName}`);
    expect(result.error).toBeUndefined();
    expect(result.hot_symbols.some((s) => s.function_name === 'getUser')).toBe(true);
  });

  it('returns cold symbols via cold-symbols command', () => {
    const result = run(`cold-symbols --repo ${repoName}`);
    expect(result.error).toBeUndefined();
    expect(result.cold_symbols.some((s) => s.function_name === 'createUser')).toBe(true);
  });
});
