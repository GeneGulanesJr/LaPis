// CLI one-shot bench: spawns `node <entry> <subcommand>` end-to-end (process boot +
// lazy command map + command execution + exit) — the cost of every terminal
// `lapis <cmd>` invocation. `mcp` boot is covered separately by
// bench/mcp-cold-start.js; this covers the CLI command path.
// Usage: node bench/cli-one-shot.js [entry=memory-store.js] [iterations=15]
const { spawn } = require('child_process');

const entry = process.argv[2] || 'memory-store.js';
const iters = Number(process.argv[3] || 15);
if (!iters || iters < 1) {
  console.error('usage: node bench/cli-one-shot.js [entry] [iterations]');
  process.exit(1);
}

const WARMUP = 3;

const CASES = [
  { key: 'stats', args: ['stats'] },
  { key: 'search', args: ['search', '--query', 'prepared statement cache'] },
];

function once(c) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...c.args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const t0 = process.hrtime.bigint();
    let err = '';
    const to = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout: ${c.key}`));
    }, 30000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.resume();
    child.on('exit', (code) => {
      clearTimeout(to);
      resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, code, stderr: err.slice(0, 400) });
    });
  });
}

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { min: +s[0].toFixed(1), p50: +p(0.5).toFixed(1), p90: +p(0.9).toFixed(1), mean: +mean.toFixed(1) };
}

(async () => {
  const out = {};
  for (const c of CASES) {
    for (let i = 0; i < WARMUP; i++) await once(c);
    const samples = [];
    let nonZeroExit = 0;
    for (let i = 0; i < iters; i++) {
      const r = await once(c);
      if (r.code !== 0) nonZeroExit++;
      if (r.stderr.trim()) process.stderr.write(`[${c.key} #${i}] stderr: ${r.stderr.trim()}\n`);
      samples.push(r.ms);
    }
    out[c.key] = { ...stats(samples), nonZeroExit, n: iters };
    process.stderr.write(`${c.key}: ${JSON.stringify(out[c.key])}\n`);
  }
  console.log(JSON.stringify({ entry, iters, ...out }, null, 2));
})().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exit(1);
});
