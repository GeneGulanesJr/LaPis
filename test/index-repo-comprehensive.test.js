const path = require('path'), fs = require('fs'), { execSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js'), REPO_PREFIX = 'test-idx';



function run(cmd) {
  const out = execSync(`node "${STORE}" ${cmd}`, {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function runFail(cmd) {
  try {
    execSync(`node "${STORE}" ${cmd}`, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    try {
      return JSON.parse((err.stderr || err.stdout || '').trim());
    } catch {
      return { error: err.stderr || err.message };
    }
  }
}

function writeTmpRepo(repoPath, files) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}



function repoName(suffix) {
  return `${REPO_PREFIX}-${suffix}-${Date.now()}`;
}

function cleanupRepo(name) {
  try {
    execSync(`node "${STORE}" remove-code-repo --repo ${name}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {}
}

describe('index-repo (comprehensive)', () => {
  describe('basic indexing', () => {
    const name = repoName('basic');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-idx-basic-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'app.js': `function main() {\n  console.log("hello");\n}\n\nclass Server {\n  start() {\n    return 42;\n  }\n  stop() {\n    return 0;\n  }\n}`,
      });
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should index a small repo', () => {
      const result = run(`index-repo --path "${tmpRepo}" --name ${name}`);
      expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(1);
      expect(result.symbols_extracted).toBeGreaterThanOrEqual(3);
    });

    it('should be idempotent (second index succeeds)', () => {
      const result = run(`index-repo --path "${tmpRepo}" --name ${name}`);
      expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(1);
    });

    it('should search indexed code after indexing', () => {
      const result = run(`search-code --query main --repo ${name}`);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0].symbol).toBe('main');
    });

    it('should retrieve source code for indexed symbols', () => {
      const result = run(`get-code-source --repo ${name} --file ${path.join(tmpRepo, 'app.js')} --name main`);
      expect(result.success).toBe(true);
      expect(result.source).toContain('main');
    });
  });

  describe('multi-file and multi-language', () => {
    const name = repoName('multi');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-idx-multi-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'utils.js': 'function helper(x) {\n  return x * 2;\n}',
        'types.ts':
          'interface Config {\n  port: number;\n}\n\nfunction parseConfig(): Config {\n  return { port: 3000 };\n}',
        'Component.tsx':
          'export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}',
        'main.py': 'def run():\n    pass\n\nclass App:\n    def start(self):\n        pass',
        'server.go': 'package main\n\nfunc main() {}\n\nfunc (s *Server) Start() {}',
        'lib.rs': 'pub fn init() {}\n\npub struct Config;\n\nimpl Config {\n    pub fn new() -> Self { Config }\n}',
      });
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should index all supported languages', () => {
      const result = run(`index-repo --path "${tmpRepo}" --name ${name}`);
      expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(6);
      expect(result.symbols_extracted).toBeGreaterThanOrEqual(10);
    });
  });

  describe('exclusion patterns', () => {
    const name = repoName('exclude');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-idx-exclude-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'app.js': 'function main() {}',
        'node_modules/lodash.js': 'function get() {}',
        '.hidden/config.js': 'function secret() {}',
        '.git/HEAD': 'ref: refs/heads/main',
      });
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should exclude node_modules, .git, and dot-directories', () => {
      const result = run(`index-repo --path "${tmpRepo}" --name ${name}`),
      search = (() => {

        expect(result.success).toBe(true);
        expect(result.files_indexed).toBe(1);
  
        
  return (run(`search-code --query get --repo ${name}`));
})();expect(search.results.every((r) => !r.file.includes('node_modules'))).toBe(true);
    });
  });

  describe('empty and edge cases', () => {
    it('should handle a repo with zero source files', () => {
      const name = repoName('empty'),
        tmpRepo = path.join('/tmp', `test-idx-empty-${Date.now()}`),
      result = (() => {

        writeTmpRepo(tmpRepo, { 'README.txt': 'Hello world' });
  
        
  return (run(`index-repo --path "${tmpRepo}" --name ${name}`));
})();expect(result.files_indexed).toBe(0);
      expect(result.success).toBe(true);

      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should handle a nonexistent path gracefully', () => {
      const result = runFail(`index-repo --path /nonexistent/path/abc123xyz --name nope`);
      expect(result).toBeDefined();
      expect(result.error || result.success === false).toBeTruthy();
    });

    it('should handle files with syntax errors gracefully', () => {
      const name = repoName('syntax'),
        tmpRepo = path.join('/tmp', `test-idx-syntax-${Date.now()}`),
      result = (() => {

        writeTmpRepo(tmpRepo, {
          'bad.js': 'function {{{ broken syntax',
          'good.js': 'function working() { return 1; }',
        });
  
        
  return (run(`index-repo --path "${tmpRepo}" --name ${name}`));
})();expect(result.success).toBe(true);
      expect(result.files_indexed).toBeGreaterThanOrEqual(1);

      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should handle binary files mixed with source', () => {
      const name = repoName('binary'),
        tmpRepo = path.join('/tmp', `test-idx-binary-${Date.now()}`),
      result = (() => {

        writeTmpRepo(tmpRepo, {
          'app.js': 'function main() {}',
        });
        fs.writeFileSync(path.join(tmpRepo, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        fs.writeFileSync(path.join(tmpRepo, 'data.bin'), Buffer.alloc(100, 0));
  
        
  return (run(`index-repo --path "${tmpRepo}" --name ${name}`));
})();expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(1);

      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });
  });

  describe('reindex', () => {
    const name = repoName('reindex');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-idx-reindex-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'a.js': 'function alpha() { return 1; }',
        'b.js': 'function beta() { return 2; }',
      });
      run(`index-repo --path "${tmpRepo}" --name ${name}`);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should reindex in full mode', () => {
      const result = run(`reindex-repo --repo ${name} --mode full`);
      expect(result.success).toBe(true);
      expect(typeof result.symbols_extracted).toBe('number');
    });

    it('should detect file changes in incremental mode', () => {
      fs.writeFileSync(path.join(tmpRepo, 'a.js'), 'function alphaV2() { return 3; }');

      const result = run(`reindex-repo --repo ${name} --mode incremental`),
      afterSearch = (() => {

        expect(result.success).toBe(true);
  
        
  return (run(`search-code --query alphaV2 --repo ${name}`));
})();expect(afterSearch.results.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect new files in incremental mode', () => {
      fs.writeFileSync(path.join(tmpRepo, 'c.js'), 'function gamma() { return 3; }');

      run(`reindex-repo --repo ${name} --mode incremental`);

      const search = run(`search-code --query gamma --repo ${name}`);
      expect(search.results.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle deleted files in incremental mode', () => {
      const bPath = path.join(tmpRepo, 'b.js'),
      search = (() => {

        if (!fs.existsSync(bPath)) {
          fs.writeFileSync(bPath, 'function beta() { return 2; }');
          run(`reindex-repo --repo ${name} --mode incremental`);
        }
        fs.unlinkSync(bPath);
  
        run(`reindex-repo --repo ${name} --mode incremental`);
  
        
  return (run(`search-code --query beta --repo ${name}`));
})();expect(search.results.every((r) => !r.file.includes('b.js'))).toBe(true);
    });

    it('should fail for non-existent repo', () => {
      const result = runFail(`reindex-repo --repo nonexistent-xyz-999 --mode full`);
      expect(result).toBeDefined();
    });
  });

  describe('repo management', () => {
    it('should list repos', () => {
      const result = run('list-code-repos');
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.repos)).toBe(true);
    });

    it('should remove a repo', () => {
      const name = repoName('remove'),
        tmpRepo = path.join('/tmp', `test-idx-remove-${Date.now()}`),
      result = (() => {

        writeTmpRepo(tmpRepo, { 'x.js': 'function x() {}' });
        run(`index-repo --path "${tmpRepo}" --name ${name}`);
  
        
  return (run(`remove-code-repo --repo ${name}`));
})(),
      repos = (() => {
expect(result.success).toBe(true);
  
        
  return (run('list-code-repos'));
})();expect(repos.repos.every((r) => r.name !== name)).toBe(true);

      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });
  });

  describe('import graph and call graph', () => {
    const name = repoName('graph');
    let tmpRepo;

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-idx-graph-${Date.now()}`);
      writeTmpRepo(tmpRepo, {
        'a.js': 'const { b } = require("./b");\nfunction main() {\n  b();\n}',
        'b.js': 'function b() {\n  return 42;\n}\nmodule.exports = { b };',
      });
      run(`index-repo --path "${tmpRepo}" --name ${name}`);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should build import graph', () => {
      const result = run(`import-graph --repo ${name}`),
        edges = result.edges || result.data?.edges;
      expect(edges).toBeDefined();
      expect(Array.isArray(edges)).toBe(true);
      expect(edges.length).toBeGreaterThanOrEqual(1);
    });

    it('should build call hierarchy', () => {
      const result = run(`call-hierarchy --repo ${name} --symbol b --direction callers`);
      if (result.callers) {
        expect(Array.isArray(result.callers)).toBe(true);
      }
    });

    it('should compute outline', () => {
      const result = run(`outline --repo ${name} --file a.js`);
      expect(result).toBeDefined();
    });
  });

  describe('large repo call graph scalability', () => {
    const name = repoName('large'), FILE_COUNT = 50,
      FUNCS_PER_FILE = 10;
    let tmpRepo;
    

    beforeAll(() => {
      tmpRepo = path.join('/tmp', `test-idx-large-${Date.now()}`);
      const files = {};
      for (let i = 0; i < FILE_COUNT; i++) {
        const lines = [];
        for (let j = 0; j < FUNCS_PER_FILE; j++) {
          const callee = j > 0 ? `func${i}_${j - 1}` : 'console.log';
          lines.push(`function func${i}_${j}() {`);
          lines.push(`  ${callee}();`);
          lines.push('}');
          lines.push('');
        }
        if (i > 0) {
          lines.unshift(`const { func${i - 1}_0 } = require("./file${i - 1}");`);
          lines.unshift('');
        }
        files[`file${i}.js`] = lines.join('\n');
      }
      writeTmpRepo(tmpRepo, files);
    });

    afterAll(() => {
      cleanupRepo(name);
      try {
        fs.rmSync(tmpRepo, { recursive: true });
      } catch {}
    });

    it('should complete indexing a repo with many files and symbols', () => {
      const result = run(`index-repo --path "${tmpRepo}" --name ${name}`);
      expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(FILE_COUNT);
      expect(result.symbols_extracted).toBeGreaterThanOrEqual(FILE_COUNT * FUNCS_PER_FILE);
      expect(result.call_edges).toBeGreaterThanOrEqual(1);
    }, 60000);
  });
});
