#!/usr/bin/env node
/**
 * Bench-tokens.js — Token efficiency benchmark
 *
 * Measures actual byte/token savings of compact format across all analysis tools.
 * Uses the real compactResponse function — no hardcoded estimates.
 *
 * Usage: node bench/bench-tokens.js [--reindex]
 */

const path = require('path');
const { execSync } = require('child_process');
const {
  BENCHMARK_TOOLS, formatBytes, pad,
  runCli, isRepoIndexed, findSymbolWithCallers,
} = require('./bench-helper');
const wf = require('../wire-format');

const REPO_NAME = 'PiMemoryExtension';
const REPO_PATH = path.resolve(__dirname, '..');

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

function unwrap(data) {
  if (data && data._meta && data.data) return data.data;
  return data;
}

function estimateRowCount(data, toolName) {
  const d = unwrap(data);
  switch (toolName) {
    case 'getSymbolImportance': return (d.nodes || []).length;
    case 'getHotspots': return (d.hotspots || d.files || []).length;
    case 'getDeadCode': {
      const syms = (d.dead_symbols || []).length;
      const files = (d.dead_files || []).length;
      return syms + files;
    }
    case 'getCouplingMetrics': return (d.metrics || d.files || []).length;
    case 'getExtractionCandidates': return (d.candidates || []).length;
    case 'getCallHierarchy': return (d.edges || []).length;
    case 'getImportGraph': return (d.edges || []).length;
    case 'getBlastRadius': return (d.edges || []).length;
    case 'getDependencyCycles': return (d.cycles || []).length;
    default: return 0;
  }
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  return { forceReindex: args.includes('--reindex') };
}

function printHeader() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     PiMemoryExtension — Token Efficiency Benchmark   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

function ensureRepoIndexed(forceReindex) {
  const indexed = isRepoIndexed(REPO_NAME);
  if (!indexed || forceReindex) {
    _doIndexRepo(forceReindex, indexed);
  } else {
    console.log('[1/3] Repo already indexed — skipping (use --reindex to force)');
  }
}

function _doIndexRepo(forceReindex, indexed) {
  console.log(`[1/3] Indexing ${REPO_NAME}...`);
  if (forceReindex && indexed) {
    execSync(`node memory-store.js remove-code-repo --repo "${REPO_NAME}"`, {
      cwd: REPO_PATH, encoding: 'utf-8', timeout: 10000,
    });
  }
  const indexResult = execSync(`node memory-store.js index-repo --path "${REPO_PATH}" --name "${REPO_NAME}"`, {
    cwd: REPO_PATH, encoding: 'utf-8', timeout: 120000,
  });
  const idx = JSON.parse(indexResult.trim());
  if (idx.error) {
    console.error(`  Index error: ${idx.error}`);
    process.exit(1);
  }
  console.log(`  Done: ${idx.symbols_extracted} symbols, ${idx.files_indexed} files`);
}

function findCallSymbol() {
  console.log('\n[2/3] Finding representative symbol for call analysis...');
  const callSymbol = findSymbolWithCallers(REPO_NAME);
  if (callSymbol) {
    console.log(`  Using symbol: "${callSymbol}"`);
  } else {
    console.log('  No suitable symbol found — using fallback');
  }
  return callSymbol;
}

function runBenchmarks(callSymbol) {
  console.log('\n[3/3] Running benchmarks...\n');

  const results = [];

  for (const tool of BENCHMARK_TOOLS) {
    const result = benchmarkTool(tool, callSymbol);
    results.push(result);
  }

  return results;
}

function benchmarkTool(tool, callSymbol) {
  let extraFlags = '';

  if (tool.cli === 'call-hierarchy' || tool.cli === 'blast-radius') {
    if (!callSymbol) {
      return { tool: tool.name, error: 'No symbol available' };
    }
    extraFlags = `--symbol "${callSymbol}"`;
  }

  let toolData;
  try {
    toolData = runCli(REPO_NAME, tool.cli, extraFlags);
  } catch (e) {
    return { tool: tool.name, error: e.message.slice(0, 60) };
  }

  if (toolData.error) {
    return { tool: tool.name, error: toolData.error };
  }

  const stats = _computeCompactStats(toolData);
  return {
    tool: tool.name,
    ...stats,
    rows: estimateRowCount(toolData, tool.toolName),
  };
}

function _computeCompactStats(toolData) {
  const payload = unwrap(toolData);
  const rawBytes = JSON.stringify(payload).length;
  const rawTokens = wf.estimateTokens(payload);
  const compacted = wf.compactResponse(payload);
  const compactBytes = JSON.stringify(compacted).length;
  const compactTokens = wf.estimateTokens(compacted);
  const savingsPct = rawBytes > 0 ? Math.round((1 - compactBytes / rawBytes) * 100) : 0;
  return { rawBytes, rawTokens, compactBytes, compactTokens, savingsPct };
}

function printResults(results) {
  _printResultsHeader();

  let totalRaw = 0, totalCompact = 0, totalRows = 0;

  for (const r of results) {
    if (r.error) {
      console.log(pad(r.tool, 15) + 'ERROR: ' + r.error.slice(0, 30));
      continue;
    }
    _printResultRow(r);
    totalRaw += r.rawBytes;
    totalCompact += r.compactBytes;
    totalRows += r.rows;
  }

  _printSummary(totalRaw, totalCompact, totalRows);
}

function _printResultsHeader() {
  console.log(pad('Tool', 15) + pad('Rows', 6) + pad('Raw (B)', 10) + pad('Compact (B)', 12) + pad('Savings', 8));
  console.log('─'.repeat(51));
}

function _printResultRow(r) {
  console.log(
    pad(r.tool, 15) +
    pad(r.rows, 6) +
    pad(r.rawBytes, 10) +
    pad(r.compactBytes, 12) +
    ('-' + r.savingsPct + '%').padStart(8)
  );
}

function _printSummary(totalRaw, totalCompact, totalRows) {
  console.log('─'.repeat(51));
  const overallPct = totalRaw > 0 ? Math.round((1 - totalCompact / totalRaw) * 100) : 0;
  console.log(
    pad('TOTAL', 15) +
    pad(totalRows, 6) +
    pad(totalRaw, 10) +
    pad(totalCompact, 12) +
    ('-' + overallPct + '%').padStart(8)
  );

  const savedBytes = totalRaw - totalCompact;
  const savedTokens = Math.round(savedBytes / 3.5);
  console.log(`\n✓ Benchmark complete.`);
  console.log(`  Total raw:     ${formatBytes(totalRaw)} (${totalRaw}B)`);
  console.log(`  Total compact: ${formatBytes(totalCompact)} (${totalCompact}B)`);
  console.log(`  Saved:         ${formatBytes(savedBytes)} (~${savedTokens} tokens, -${overallPct}%)`);
}

function main() {
  printHeader();
  const { forceReindex } = parseArgs();
  ensureRepoIndexed(forceReindex);
  const callSymbol = findCallSymbol();
  const results = runBenchmarks(callSymbol);
  printResults(results);
}

try {
  main();
} catch (e) {
  console.error('Benchmark failed:', e.message);
  process.exit(1);
}
