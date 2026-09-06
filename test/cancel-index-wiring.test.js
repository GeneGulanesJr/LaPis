// Wiring test for cancel-index: the gateway command, the MCP catalog entry,
// and the Pi extension tool must all exist and agree (follow-up to #295,
// which made cancellation actually work but exposed it nowhere).

describe('cancel-index wiring', () => {
  it('gateway dispatch validates the job argument', async () => {
    const gateway = require('../src/cli/gateway');
    const result = await gateway.dispatch('cancel-index', {});
    expect(result).toEqual({ error: 'Usage: cancel-index --job <id>' });
  });

  it('gateway dispatch returns false for an unknown (never-started) job', async () => {
    const gateway = require('../src/cli/gateway');
    const result = await gateway.dispatch('cancel-index', { job: '42424242' });
    expect(result).toBe(false);
  });

  it('cancel-index is listed in the CLI usage surface', () => {
    const { USAGE } = require('../src/cli/commands/code-index');
    expect(USAGE['cancel-index']).toBe('--job <id>');
  });

  it('the Pi extension registers a cancel-index tool (MCP parity)', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync('extensions/memory-layer/tools/memory-tools.ts', 'utf8');
    expect(src).toMatch(/name:\s*'cancel-index'/);
  });
});
