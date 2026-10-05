// Memory-growth soak for the MCP transport: spawns `node <entry> mcp`, completes
// the handshake, then runs N sequential memory-search calls while sampling the
// SERVER process RSS (via tasklist, Windows) every `sampleEvery` calls. Detects
// leaks in the long-lived server process a host keeps alive — cold/warm latency
// benches cannot see this.
// Usage: node bench/memory-soak.js [entry=memory-store.js] [calls=3000] [sampleEvery=500]
// Run with LAPIS_HOME pointing at a disposable copy — every search logs a recall row.
const { spawn, execFileSync } = require('child_process');

const entry = process.argv[2] || 'memory-store.js';
const calls = Number(process.argv[3] || 3000);
const sampleEvery = Number(process.argv[4] || 500);

const QUERIES = ['prepared statement cache', 'database', 'search ranking', 'hook guardrails', 'code indexing'];

function rssKB(pid) {
  // tasklist prints CSV rows; the last column of the data row is working set in KB.
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
  }).trim();
  const m = out.match(/"([\d,]+)\s*K"/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

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

(async () => {
  const { child, request } = await conn();
  const series = [];
  const sample = (label, i) => {
    const kb = rssKB(child.pid);
    if (kb !== null) {
      series.push({ call: i, rssMB: +(kb / 1024).toFixed(1) });
      process.stderr.write(`[${label}] call=${i} rss=${series[series.length - 1].rssMB}MB\n`);
    }
  };
  sample('start', 0);
  let errors = 0;
  for (let i = 0; i < calls; i++) {
    const res = await request('tools/call', {
      name: 'memory-search',
      arguments: { query: QUERIES[i % QUERIES.length] },
    });
    if (res.error || (res.result && res.result.isError)) errors++;
    if ((i + 1) % sampleEvery === 0) sample('soak', i + 1);
  }
  sample('end', calls);
  child.kill();
  console.log(JSON.stringify({ entry, calls, errors, rssSeries: series }, null, 2));
})().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exit(1);
});
