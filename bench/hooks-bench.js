// Hook-latency bench for the Claude Code bridge: spawns `node <entry> claude-code
// hook <event>` with realistic stdin payloads and measures full process wall time
// (spawn → exit) — the per-event cost a host actually pays. Hooks are the
// highest-frequency LaPis surface: PreToolUse fires on every tool call,
// UserPromptSubmit on every prompt.
// Usage: node bench/hooks-bench.js [entry=memory-store.js] [iterations=20]
// Run with LAPIS_HOME pointing at a disposable copy — this bench writes session
// state and (on UserPromptSubmit) performs memory reads that log recalls.
const { spawn } = require('child_process');
const path = require('path');

const entry = process.argv[2] || 'memory-store.js';
const iters = Number(process.argv[3] || 20);
if (!iters || iters < 1) {
  console.error('usage: node bench/hooks-bench.js [entry] [iterations]');
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, '..');
const SESSION_ID = `bench-hooks-${process.pid}`;
const WARMUP = 3;

const CASES = [
  {
    key: 'PreToolUse:Read',
    event: 'PreToolUse',
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Read',
      tool_input: { file_path: path.join(REPO_ROOT, 'src', 'mcp', 'server.js') },
      cwd: REPO_ROOT,
    },
  },
  {
    key: 'PreToolUse:Bash',
    event: 'PreToolUse',
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
      cwd: REPO_ROOT,
    },
  },
  {
    key: 'UserPromptSubmit',
    event: 'UserPromptSubmit',
    payload: {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      prompt: 'Fix the search ranking bug in the memory domain layer',
      cwd: REPO_ROOT,
    },
  },
];

function once(c, sessionId) {
  return new Promise((resolve, reject) => {
    const payload = { ...c.payload, session_id: sessionId };
    const child = spawn(process.execPath, [entry, 'claude-code', 'hook', c.event], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const t0 = process.hrtime.bigint();
    let out = '';
    let err = '';
    const to = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout: ${c.key}`));
    }, 30000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      clearTimeout(to);
      resolve({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        code,
        stdoutBytes: Buffer.byteLength(out),
        stderr: err.slice(0, 400),
      });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return {
    min: +s[0].toFixed(1),
    p50: +p(0.5).toFixed(1),
    p90: +p(0.9).toFixed(1),
    mean: +mean.toFixed(1),
  };
}

(async () => {
  const out = {};
  for (const c of CASES) {
    for (let i = 0; i < WARMUP; i++) await once(c, SESSION_ID + '-warm');
    const samples = [];
    let nonZeroExit = 0;
    for (let i = 0; i < iters; i++) {
      const r = await once(c, SESSION_ID);
      if (r.code !== 0) nonZeroExit++;
      if (r.stderr.trim()) process.stderr.write(`[${c.key} #${i}] stderr: ${r.stderr.trim()}\n`);
      samples.push(r.ms);
      if (c.event === 'UserPromptSubmit') out._upsStdoutBytes = r.stdoutBytes;
    }
    out[c.key] = { ...stats(samples), nonZeroExit, n: iters };
    process.stderr.write(`${c.key}: ${JSON.stringify(out[c.key])}\n`);
  }
  console.log(JSON.stringify({ entry, iters, ...out }, null, 2));
})().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exit(1);
});
