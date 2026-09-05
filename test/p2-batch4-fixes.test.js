// Regression tests for review batch 4: #289 (cached rejected gateway init),
// #290 (memCmd bypassing MAIN_THREAD_BLOCKING_COMMANDS), #297 (daemon POST
// without a timeout), #298 (hermes allowlist crash on null JSON), and
// #299 (prototype pollution via token-saver rule maps).
const fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-p2-batch4-'));

describe('#289 gateway init failure is retryable', () => {
  it('re-runs init after a transient failure instead of caching the rejection', async () => {
    const dbModule = require('../db'),
      gateway = require('../src/cli/gateway'),
      originalEnsureDb = dbModule.ensureDb;
    dbModule.ensureDb = () => {
      throw new Error('transient lock at startup');
    };
    try {
      await expect(gateway.dispatch('search', {})).rejects.toThrow('transient lock at startup');
    } finally {
      dbModule.ensureDb = originalEnsureDb;
    }
    // Without the fix, this call re-awaited the same cached rejection forever.
    const result = await gateway.dispatch('search', {});
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('transient lock at startup');
  });
});

describe('#290 memCmd honors MAIN_THREAD_BLOCKING_COMMANDS', () => {
  it('routes blocking commands to the child-process path before any in-process dispatch', () => {
    const fsMod = require('node:fs'),
      src = fsMod.readFileSync(
        path.join(__dirname, '..', 'extensions', 'memory-layer', 'host', 'memory-client.ts'),
        'utf8',
      ),
      body = src.slice(src.indexOf('export async function memCmd')),
      dispatchCall = body.indexOf('getInProcessDispatch()');
    expect(dispatchCall).toBeGreaterThan(-1);
    // The blocking gate must appear before the in-process dispatch lookup,
    // and route to memViaChildProcess like mem() does.
    const gate = body.indexOf('MAIN_THREAD_BLOCKING_COMMANDS.has(cmd)');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(dispatchCall);
    expect(body).toContain('return memViaChildProcess(cmd, {});');
  });
});

describe('#297 daemon dispatch timeout falls back to direct mode', () => {
  it('aborts a stalled daemon POST and rejects', async () => {
    const { dispatchViaDaemon } = require('../src/claude-code/dispatch-client'),
      hanging = http.createServer(() => {}); // accepts connections, never responds
    await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${hanging.address().port}`;
      await expect(dispatchViaDaemon(url, 'search', { query: 'x' }, { timeoutMs: 250 })).rejects.toThrow();
    } finally {
      hanging.close();
    }
  }, 15000);

  it('falls back to the direct dispatcher when the daemon wedges', async () => {
    const { dispatch } = require('../src/claude-code/dispatch-client'),
      hanging = http.createServer(() => {});
    await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${hanging.address().port}`,
        result = await dispatch(
          'search',
          { query: 'x' },
          {
            resolveDaemonUrl: () => url,
            directDispatch: (cmd) => ({ via: 'direct', cmd }),
            timeoutMs: 300,
          },
        );
      expect(result.via).toBe('direct');
    } finally {
      hanging.close();
    }
  }, 15000);
});

describe('#298 hermes mergeAllowlist tolerates non-object JSON', () => {
  const { mergeAllowlist } = require('../src/hermes/install'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-allowlist-'));

  it('degrades a null allowlist file instead of crashing', () => {
    const file = path.join(dir, 'null.json');
    fs.writeFileSync(file, 'null');
    expect(() => mergeAllowlist(file, 'lapis hook cmd')).not.toThrow();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Array.isArray(data.approvals)).toBe(true);
    expect(data.approvals.length).toBeGreaterThan(0);
  });

  it('degrades a scalar allowlist file instead of silently dropping approvals', () => {
    const file = path.join(dir, 'scalar.json');
    fs.writeFileSync(file, '"weird"');
    expect(() => mergeAllowlist(file, 'lapis hook cmd')).not.toThrow();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Array.isArray(data.approvals)).toBe(true);
    expect(data.approvals.length).toBeGreaterThan(0);
  });

  it('still merges into an existing valid allowlist', () => {
    const file = path.join(dir, 'valid.json');
    fs.writeFileSync(file, JSON.stringify({ approvals: [{ event: 'on_session_start', command: 'lapis hook cmd' }] }));
    expect(() => mergeAllowlist(file, 'lapis hook cmd')).not.toThrow();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Deduped: no duplicate entry for the same event+command.
    expect(data.approvals.filter((a) => a.event === 'on_session_start')).toHaveLength(1);
  });
});

describe('#299 token-saver rule maps are prototype-pollution safe', () => {
  it('compressLogs ignores __proto__ log lines without polluting Object.prototype', () => {
    const { compressLogs } = require('../src/token-saver/rules/logs'),
      out = compressLogs({ stdout: '__proto__\nplain line\n__proto__\nplain line', stderr: '' });
    expect(out).toBeDefined();
    expect({}.count).toBeUndefined();
    expect(Object.prototype.count).toBeUndefined();
  });

  it('compressSearchOutput keeps a __proto__ file path instead of dropping it', () => {
    const { compressSearchOutput } = require('../src/token-saver/rules/search'),
      out = compressSearchOutput({ stdout: '__proto__:12: some match here\n', stderr: '', commandArgs: ['needle'] });
    expect(JSON.stringify(out)).toContain('some match here');
    expect({}.polluted).toBeUndefined();
  });

  it('compressListOutput tolerates a __proto__ directory', () => {
    const { compressListOutput } = require('../src/token-saver/rules/list-output'),
      out = compressListOutput({ stdout: '__proto__\nsrc\n', stderr: '' });
    expect(out).toBeDefined();
    expect({}.polluted).toBeUndefined();
  });
});
