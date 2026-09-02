const path = require('path'), fs = require('fs'), os = require('os'), { execFile, spawn } = require('child_process'),
  MEMORY_SCRIPT = path.resolve(__dirname, '..', 'memory-store.js');




// Verify that indexing via the child-process path (spawn) works correctly
// And returns full results — not just a jobId. This is the path that
// MemStreaming now uses for indexing commands to avoid UI freezes.
describe('indexing via child-process path', () => {
  it('index-repo returns full result via child process', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-cp-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const x = 1;\n');
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'b.ts'), 'export const y = 2;\n');
      const result = await new Promise((resolve, reject) => {
        execFile(
          'node',
          [MEMORY_SCRIPT, 'index-repo', '--path', tmpDir, '--name', 'cp-result-test'],
          { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              return reject(err);
            }
            try {
              resolve(JSON.parse(stdout.trim()));
            } catch (e) {
              reject(new Error(`Invalid JSON: ${stdout.slice(0, 200)}`));
            }
          },
        );
      });

      // Full indexing result — NOT { jobId, status: 'running' }
      expect(result.success).toBe(true);
      expect(result.repo).toBe('cp-result-test');
      expect(result.file_count).toBeGreaterThanOrEqual(2);
      expect(result.symbol_count).toBeGreaterThanOrEqual(2);
      expect(result.jobId).toBeUndefined();
      expect(result.timing_ms).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 35000);

  it('index-repo with --progress streams progress on stderr', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-cp-prog-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const z = 3;\n');
      let progressSeen = false;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          'node',
          [MEMORY_SCRIPT, 'index-repo', '--progress', '--path', tmpDir, '--name', 'cp-prog-test'],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );

        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
          for (const line of chunk.toString().split('\n')) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.progress) {
                progressSeen = true;
              }
            } catch {
              /* Not JSON */
            }
          }
        });

        child.on('close', (code) => {
          if (code !== 0 && !stdout.trim()) {
            return reject(new Error(`Exited with code ${code}: ${stderr}`));
          }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new Error(`Invalid JSON: ${stdout.slice(0, 200)}`));
          }
        });

        child.on('error', reject);

        // Timeout safety
        setTimeout(() => {
          child.kill();
          reject(new Error('Timed out'));
        }, 30000);
      });

      expect(result.success).toBe(true);
      expect(progressSeen).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 35000);
});
