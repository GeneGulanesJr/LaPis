// `lapis run` wrapper: wrapped-command flags and --remember project key.
// LAPIS_HOME points at a per-file temp DB (test/setup-lapis-home.js), inherited by the child.
const { spawnSync } = require('node:child_process'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  STORE = path.join(__dirname, '..', 'memory-store.js');

function lapis(args) {
  return spawnSync(process.execPath, [STORE, ...args], { encoding: 'utf8', timeout: 60000 });
}

describe('lapis run', () => {
  test('passes --help to the wrapped command instead of printing LaPis help', () => {
    const r = lapis(['run', '--text', 'node', '-e', "console.log('wrapped-' + process.argv[1])", '--', '--help']);
    expect(r.stdout).toContain('wrapped---help');
    expect(r.status).toBe(0);
  });

  test('--remember saves under the short project key, not the folder path', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-run-')), 'RunProj');
    fs.mkdirSync(dir);
    lapis(['run', '--remember', '--cwd', dir, 'node', '-e', "console.log('remember-me')"]);
    const { sqlJson } = require('../db'),
      rows = sqlJson("SELECT project FROM observations WHERE session_id = 'token-saver'");
    expect(rows.map((r) => r.project)).toEqual(['RunProj']);
  });
});
