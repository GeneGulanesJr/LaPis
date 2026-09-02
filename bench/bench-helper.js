/**
 * Bench-helper.js — Shared utilities for token efficiency benchmarks
 */

const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');



// ══════════════════════════════════════════════════════════
// LAPIS ROOT DETECTION
// ══════════════════════════════════════════════════════════



{
const LAPIS_ROOT = findLapisRoot(),
  CLI_MAX_BUFFER = 64 * 1024 * 1024,
  // ══════════════════════════════════════════════════════════
  // BENCHMARK MATRIX
  // ══════════════════════════════════════════════════════════

  BENCHMARK_TOOLS = [
    { name: 'importance', cli: 'importance', toolName: 'getSymbolImportance' },
    { name: 'hotspots', cli: 'hotspots', toolName: 'getHotspots' },
    { name: 'dead-code', cli: 'dead-code', toolName: 'getDeadCode' },
    { name: 'coupling', cli: 'coupling', toolName: 'getCouplingMetrics' },
    { name: 'extraction', cli: 'extractable', toolName: 'getExtractionCandidates' },
    { name: 'call-hierarchy', cli: 'call-hierarchy', toolName: 'getCallHierarchy' },
    { name: 'import-graph', cli: 'import-graph', toolName: 'getImportGraph' },
    { name: 'cycles', cli: 'cycles', toolName: 'getDependencyCycles' },
    { name: 'blast-radius', cli: 'blast-radius', toolName: 'getBlastRadius' },
  ];

// ══════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════

const { estimateTokens } = require(path.join(LAPIS_ROOT, 'utils'));

function formatBytes(n) {
  if (n < 1024) {
    return `${n}B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function pct(savings) {
  const sign = savings >= 0 ? '-' : '+';
  return `${sign}${Math.abs(Math.round(savings * 100))}%`;
}

function pad(str, width) {
  return String(str).padEnd(width);
}

function runCli(repo, subcommand, extraFlags = '') {
  const msPath = path.join(LAPIS_ROOT, 'memory-store.js'),
    extraArgs = extraFlags ? extraFlags.split(/\s+/).filter(Boolean) : [],
    args = [msPath, subcommand, '--repo', repo, ...extraArgs];
  try {
    const stdout = execFileSync('node', args, {
      cwd: LAPIS_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: CLI_MAX_BUFFER,
    }).trim();
    return JSON.parse(stdout);
  } catch (e) {
    return { error: e.message, stderr: e.stderr?.toString() };
  }
}

function isRepoIndexed(repo) {
  try {
    const msPath = path.join(LAPIS_ROOT, 'memory-store.js'),
      stdout = execFileSync('node', [msPath, 'list-code-repos'], {
        cwd: LAPIS_ROOT,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim(),
      data = JSON.parse(stdout);
    return (data.repos || []).some((r) => r.name === repo);
  } catch {
    return false;
  }
}

function findSymbolWithCallers(repo) {
  try {
    const hotFile = _pickHotFile(repo);
    if (!hotFile) {
      return null;
    }
    return _pickCallSymbolFromOutline(repo, hotFile);
  } catch {
    return null;
  }
}

function _pickHotFile(repo) {
  const msPath = path.join(LAPIS_ROOT, 'memory-store.js'),
    stdout = execFileSync('node', [msPath, 'hotspots', '--repo', repo, '--top', '1'], {
      cwd: LAPIS_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim(),
    data = JSON.parse(stdout),
    payload = data.data || data,
    files = payload.hotspots || payload.files || [];
  if (files.length === 0) {
    return null;
  }
  return files[0].file_path || files[0].path;
}

function _pickCallSymbolFromOutline(repo, hotFile) {
  const msPath = path.join(LAPIS_ROOT, 'memory-store.js'),
    outlineOut = execFileSync('node', [msPath, 'outline', '--repo', repo, '--file', hotFile], {
      cwd: LAPIS_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim(),
    outlineRaw = JSON.parse(outlineOut),
    outline = outlineRaw.data || outlineRaw,
    syms = [
      ...(outline.standalone || []),
      ...(outline.symbols || []),
      ...(outline.classes || []).flatMap((c) => c.methods || []),
    ];
  return syms.find((s) => s.kind === 'function' && s.name.length > 3)?.name || syms[0]?.name || null;
}

module.exports = {
  BENCHMARK_TOOLS,
  estimateTokens,
  formatBytes,
  pct,
  pad,
  runCli,
  isRepoIndexed,
  findSymbolWithCallers,
};
function findLapisRoot() {
  const candidates = [
    path.resolve(__dirname, '..'),
    process.env.LAPIS_PATH,
    path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.pi',
      'agent',
      'git',
      'github.com',
      'GeneGulanesJr',
      'LaPis',
    ),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.pi', 'agent', 'skills', 'memory-layer'),
  ];
  for (const dir of candidates) {
    if (!dir) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    const msPath = path.join(dir, 'memory-store.js');
    if (fs.existsSync(msPath)) {
      return dir;
    }
  }
  console.error('ERROR: Cannot find LaPis root (memory-store.js). Set LAPIS_PATH or run from the LaPis directory.');
  process.exit(1);
}
}
