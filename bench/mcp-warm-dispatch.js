// Warm-dispatch bench for the MCP transport: spawns `node <entry> mcp` once,
// completes the initialize handshake, then times N sequential tools/call
// round-trips per tool case (steady state: JIT warm, statement cache warm).
// Complements bench/mcp-cold-start.js (process startup) with the per-call cost
// a long-lived host actually pays.
// Usage: node bench/mcp-warm-dispatch.js <entry.js> [iterations=60]
const { spawn } = require('child_process');

const entry = process.argv[2];
const iters = Number(process.argv[3] || 60);
if (!entry) {
  console.error('usage: node bench/mcp-warm-dispatch.js <entry.js> [iterations]');
  process.exit(1);
}

const CASES = [
  { name: 'memory-search', args: { query: 'prepared statement cache' } },
  { name: 'memory-search', args: { query: 'database' } },
  { name: 'memory-get', args: { id: 1 } },
  { name: 'memory-code', args: { mode: 'search', query: 'dispatch' } },
  { name: 'memory-code', args: { mode: 'outline', file: 'src/mcp/server.js' } },
  { name: 'memory-doc', args: { mode: 'search', query: 'indexing' } },
  { name: 'memory-related', args: { id: 1 } },
  { name: 'memory-code', args: { mode: 'preflight', task: 'fix a bug in the search ranking path' } },
  { name: 'memory-code', args: { mode: 'agent-pack', task: 'add a retry helper to the db layer' } },
  {
    // Unique per call so the save path (insert + recall bookkeeping) is
    // exercised rather than the duplicate-detection early return.
    name: 'memory-save',
    argsOf: (i) => ({
      title: `bench-warm-dispatch-${process.pid}-${i}`,
      content: '**What**: bench row. **Why**: warm write-path measurement. **Where**: bench. **Learned**: n/a.',
      type: 'learning',
    }),
  },
];

function conn() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    let nextId = 1;
    const to = setTimeout(() => {
      child.kill();
      reject(new Error('timeout during initialize'));
    }, 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve: res } = pending.get(msg.id);
          pending.delete(msg.id);
          res(msg);
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, { resolve: res });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bench', version: '0' },
    }).then(() => {
      clearTimeout(to);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      resolve({ child, request });
    });
  });
}

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { min: +s[0].toFixed(2), p50: +p(0.5).toFixed(2), p90: +p(0.9).toFixed(2), mean: +mean.toFixed(2) };
}

(async () => {
  const { child, request } = await conn();
  const out = {};
  for (const c of CASES) {
    const key = `${c.name}(${c.args ? c.args.mode || c.args.id || 'query' : 'write'})`;
    for (let i = 0; i < 5; i++) await request('tools/call', { name: c.name, arguments: c.args || c.argsOf(i) });
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const t0 = process.hrtime.bigint();
      await request('tools/call', { name: c.name, arguments: c.args || c.argsOf(i) });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    out[key] = stats(samples);
  }
  child.kill();
  console.log(JSON.stringify({ entry, iters, ...out }, null, 2));
})().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exit(1);
});
