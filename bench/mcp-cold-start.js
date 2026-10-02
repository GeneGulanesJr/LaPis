// Cold-start bench for the MCP transport: spawns `node <entry> mcp`, measures
// time-to-initialize-response and time-to-tools-list over stdio.
// Usage: node bench/mcp-cold-start.js <entry.js> [iterations=9]
const { spawn } = require('child_process');

const entry = process.argv[2];
const iters = Number(process.argv[3] || 9);
if (!entry) {
  console.error('usage: node bench/mcp-cold-start.js <entry.js> [iterations]');
  process.exit(1);
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bench', version: '0' },
  },
});
const INITED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

function once() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const t0 = process.hrtime.bigint();
    let buf = '';
    let stage = 0;
    let tInit = 0;
    const to = setTimeout(() => {
      child.kill();
      reject(new Error('timeout waiting for responses'));
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
        if (stage === 0 && msg.id === 0 && msg.result) {
          stage = 1;
          tInit = Number(process.hrtime.bigint() - t0) / 1e6;
          child.stdin.write(INITED + '\n' + LIST + '\n');
        } else if (stage === 1 && msg.id === 1 && msg.result) {
          const tList = Number(process.hrtime.bigint() - t0) / 1e6;
          clearTimeout(to);
          child.kill();
          resolve({ tInit, tList });
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
    child.on('exit', (code) => {
      if (stage < 2) {
        clearTimeout(to);
        reject(new Error('child exited early (code=' + code + ')'));
      }
    });
    child.stdin.write(INIT + '\n');
  });
}

(async () => {
  const inits = [];
  const lists = [];
  for (let i = 0; i < iters; i++) {
    const r = await once();
    inits.push(r.tInit);
    lists.push(r.tList);
    process.stderr.write(`#${i} init=${r.tInit.toFixed(0)}ms tools=${r.tList.toFixed(0)}ms\n`);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const round = (v) => Math.round(v);
  console.log(
    JSON.stringify({
      entry,
      iters,
      initMs: { min: round(Math.min(...inits)), median: round(med(inits)) },
      toolsMs: { min: round(Math.min(...lists)), median: round(med(lists)) },
    }),
  );
})().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exit(1);
});
