// #397: cli.js and dispatch (MCP / Pi / daemon) share one deps builder, so
// Commands like cleanup-sessions get a real withTransaction on every path.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-397-'));

describe('gateway buildDeps (#397)', () => {
  it('includes withTransaction and the tier config', () => {
    const deps = require('../src/cli/gateway').buildDeps();
    expect(deps.withTransaction).toBe(require('../db').withTransaction);
    expect(Object.keys(deps.TOOL_TIERS)).toEqual(['core', 'standard', 'full']);
    expect(typeof deps._readTierConfig).toBe('function');
    expect(typeof deps.softDeleteObservation).toBe('function');
  });

  it('schema.sql does not set user_version (migrations own it)', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    expect(schema).not.toMatch(/^\s*PRAGMA\s+user_version/im);
  });
});
