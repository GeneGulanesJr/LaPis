#!/usr/bin/env node
// Realworld Pi memory benchmark.
//
// Runs Pi against real code-editing tasks (bugfixes, features, refactors)
// With and without memory, then grades: tests pass, diff correct, answer
// Includes expected facts.
//
// Usage:
//   Npm run bench:pi-realworld
//   Node bench/realworld/bench-pi-realworld.js --runs 3
//   Node bench/realworld/bench-pi-realworld.js --only bugfix-createdb-config

'use strict';

const fs = require('fs'), os = require('os'), path = require('path'), { execSync } = require('child_process'), { spawn } = require('child_process'), { parsePiOutput } = require('../bench-pi-paired'), { runTests } = require('./graders/run-tests'), { checkDiff } = require('./graders/check-diff'), { checkAnswer } = require('./graders/check-answer'), { checkTrajectory } = require('./graders/check-trajectory'), { checkConstraints } = require('./graders/check-constraints'),
  TASKS_DIR = path.join(__dirname, 'tasks'),
  FIXTURES_DIR = path.join(__dirname, 'fixtures'),
  DEFAULT_RUNS = 3,
  DEFAULT_TIMEOUT_MS = 30 * 60 * 1000,
  PI_CONFIG_FILES = ['models.json', 'settings.json', 'auth.json'];











// ══════════════════════════════════════════════════════════
// ARG PARSING
// ══════════════════════════════════════════════════════════





// ══════════════════════════════════════════════════════════
// GIT WORKTREE MANAGEMENT
// ══════════════════════════════════════════════════════════







// ══════════════════════════════════════════════════════════
// SETUP: PATCH APPLICATION
// ══════════════════════════════════════════════════════════



// ══════════════════════════════════════════════════════════
// SETUP: MEMORY SEEDING
// ══════════════════════════════════════════════════════════





// ══════════════════════════════════════════════════════════
// SETUP: NO-MEMORY HOME
// ══════════════════════════════════════════════════════════







// ══════════════════════════════════════════════════════════
// PI INVOCATION
// ══════════════════════════════════════════════════════════





// ══════════════════════════════════════════════════════════
// GRADING
// ══════════════════════════════════════════════════════════



// ══════════════════════════════════════════════════════════
// TASK DISCOVERY
// ══════════════════════════════════════════════════════════





// ══════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════

async function runTaskSide(task, side, runIndex, args, repoRoot, noMemoryHome, memoryOnHome) {
  const runId = `${task.id}.${side}.run${runIndex}`,
    worktreePath = path.join(args.outDir, 'worktrees', runId),
    outFile = path.join(args.outDir, 'transcripts', `${runId}.jsonl`);

  benchLog(`[${runId}] Creating worktree at ${task.setup.checkout}`);
  createWorktree(repoRoot, task.setup.checkout, worktreePath);

  try {
    // Apply patch if specified
    if (task.setup.apply_patch) {
      const patchPath = path.resolve(FIXTURES_DIR, task.setup.apply_patch);
      benchLog(`[${runId}] Applying patch ${task.setup.apply_patch}`);
      applyPatch(worktreePath, patchPath);
    }

    // Install deps in worktree (needed for test running)
    try {
      benchLog(`[${runId}] Installing dependencies`);
      execSync('npm install --ignore-scripts', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: 'pipe',
      });
    } catch {
      benchLog(`[${runId}] WARN: npm install failed, tests may fail`);
    }

    // Seed memory for memory-on side into isolated DB
    if (side === 'memory-on' && task.setup.seed_memory) {
      const seedPath = path.resolve(FIXTURES_DIR, task.setup.seed_memory);
      benchLog(`[${runId}] Seeding memory from ${task.setup.seed_memory}`);
      seedMemory(seedPath, memoryOnHome);
    }

    // Run Pi with the appropriate HOME
    const homeDir = side === 'memory-off' ? noMemoryHome : memoryOnHome,
    command = (() => {

      benchLog(`[${runId}] Starting Pi (${side})`);
      
  return (buildPiCommand(homeDir, task.prompt, outFile));
})();fs.mkdirSync(path.dirname(outFile), { recursive: true });
    {
const run = await runCommand(command, worktreePath, args.timeoutMs);
    benchLog(`[${runId}] Pi finished in ${run.elapsed_ms}ms`);

    // Parse output
    let raw = '', grade;
    if (fs.existsSync(outFile)) {
      raw = fs.readFileSync(outFile, 'utf-8');
    }
    if (!raw && (run.stdout || run.stderr)) {
      raw = `${run.stdout}\n${run.stderr}`;
    }
    {
const parsed = parsePiOutput(raw);

    // Grade (skip if Pi timed out or crashed)
    
    if (run.error) {
      grade = {
        tests: { passed: 0, failed: 0, total: 0, skipped: true },
        diff: { passed: false, touched: [], violations: [], missed: [], linesChanged: 0 },
        answer: { matched: 0, total: 0, score: 0, facts: [], skipped: true },
        trajectory: checkTrajectory(parsed),
        constraints: checkConstraints(task, worktreePath),
        overall: false,
        incomplete: true,
      };
    } else {
      grade = gradeRun(task, worktreePath, parsed);
    }
    benchLog(
      `[${runId}] Grade: overall=${grade.overall}, tests=${grade.tests.passed}/${grade.tests.total}, diff=${grade.diff.passed}`,
    );

    return {
      side,
      run_index: runIndex,
      elapsed_ms: run.elapsed_ms,
      error: run.error,
      usage: parsed.usage,
      tool_counts: parsed.tool_counts,
      behavior: parsed.behavior,
      grade,
    };
  }
}
} finally {
    if (!args.noCleanup) {
      removeWorktree(repoRoot, worktreePath);
    }
  }
}

// ══════════════════════════════════════════════════════════
// REPORTING
// ══════════════════════════════════════════════════════════









// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

let progressActive = false;

function benchLog(message = '') {
  finishProgress();
  console.log(message);
}

function finishProgress() {
  if (progressActive && process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    progressActive = false;
  }
}

async function runWarmup(warmupFile, repoRoot, outDir, warmupHome) {
  if (!fs.existsSync(warmupFile)) {
    benchLog(`[warmup] WARN: warmup file not found: ${warmupFile}`);
    return;
  }
  const warmup = JSON.parse(fs.readFileSync(warmupFile, 'utf-8'));
  if (!Array.isArray(warmup) || warmup.length === 0) {
    return;
  }

  for (const prompt of warmup) {
    const warmupOut = path.join(outDir, 'warmup', `warmup-${Date.now()}.jsonl`),
    command = (() => {

      fs.mkdirSync(path.dirname(warmupOut), { recursive: true });
      
  return (buildPiCommand(warmupHome, prompt, warmupOut));
})();benchLog(`[warmup] Running: ${prompt.slice(0, 80)}...`);
    // eslint-disable-next-line no-await-in-loop
    await runCommand(command, repoRoot, 120_000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2)),
    tasks = loadTasks(TASKS_DIR, {
      only: args.only,
      onlyLong: args.onlyLong,
      onlyShort: args.onlyShort,
      category: args.category,
    }),
  outDir = (() => {

  
    if (tasks.length === 0) {
      console.error('No tasks found. Add task JSON files to bench/realworld/tasks/');
      process.exit(2);
    }
  
    
  return (path.resolve(args.outDir));
})();fs.mkdirSync(outDir, { recursive: true });
  const repoRoot = getRepoRoot(),
    noMemoryHome = prepareNoMemoryHome(outDir);

  // For accumulate mode, create a single shared memory-on HOME
  let accumulateMemoryOnHome = null;
  if (args.accumulate) {
    accumulateMemoryOnHome = prepareMemoryOnHome(outDir, 'accumulate');
  }

  {
const longCount = tasks.filter((t) => t.horizon === 'long').length,
    shortCount = tasks.length - longCount,
  allResults = (() => {

    benchLog(`[bench] Realworld Pi Memory Benchmark`);
    benchLog(`[bench] Tasks: ${tasks.length} (${longCount} long, ${shortCount} short), Runs per side: ${args.runs}`);
    benchLog(`[bench] Output: ${outDir}`);
    benchLog(`[bench] memory-off HOME: ${noMemoryHome}`);
    if (args.accumulate) {
      benchLog(`[bench] Accumulate mode ON — shared memory-on HOME across tasks`);
      benchLog(`[bench] memory-on HOME: ${accumulateMemoryOnHome}`);
    } else {
      benchLog(`[bench] memory-on: isolated HOME per task (seeded from fixtures)`);
    }
    if (args.warmup) {
      benchLog(`[bench] Warmup: ${args.warmup}`);
    }
    benchLog('');
  
    
  return ([]);
})(); // Warmup once before all tasks (builds organic memory for memory-on side)
  if (args.warmup) {
    const warmupHome = accumulateMemoryOnHome || prepareMemoryOnHome(outDir, 'warmup');
    benchLog(`[warmup] Running warmup prompts into ${warmupHome}`);
    await runWarmup(args.warmup, repoRoot, outDir, warmupHome);
  }

  for (const task of tasks) {
    for (let runIndex = 0; runIndex < args.runs; runIndex++) {
      // Create or reuse memory-on HOME
      let memoryOnHome;
      if (args.accumulate) {
        memoryOnHome = accumulateMemoryOnHome;
      } else if (runIndex === 0) {
        memoryOnHome = prepareMemoryOnHome(outDir, task.id);
      } else {
        memoryOnHome = prepareMemoryOnHome(outDir, `${task.id}-run${runIndex}`);
      }

      // Memory-off first, then memory-on
      // eslint-disable-next-line no-await-in-loop
      const off = await runTaskSide(task, 'memory-off', runIndex, args, repoRoot, noMemoryHome, memoryOnHome),
        // eslint-disable-next-line no-await-in-loop
        on = await runTaskSide(task, 'memory-on', runIndex, args, repoRoot, noMemoryHome, memoryOnHome);

      allResults.push({ task_id: task.id, category: task.category, ...off });
      allResults.push({ task_id: task.id, category: task.category, ...on });
    }
  }

  // Save full results
  {
const report = {
      generated_at: new Date().toISOString(),
      host: os.hostname(),
      runs: args.runs,
      tasks: tasks.map((t) => t.id),
      results: allResults,
    },
    reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  // Print report
  printReport(allResults);
  benchLog(`Report saved to: ${reportPath}`);
}
}
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  createWorktree,
  removeWorktree,
  applyPatch,
  seedMemory,
  gradeRun,
  printReport,
  loadTasks,
  prepareNoMemoryHome,
  prepareMemoryOnHome,
};
function parseArgs(argv) {
  const args = {
    runs: DEFAULT_RUNS,
    only: null,
    onlyLong: false,
    onlyShort: false,
    category: null,
    outDir: path.join(__dirname, 'results', `realworld-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    noCleanup: false,
    warmup: null,
    accumulate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runs') {
      args.runs = parseInt(argv[++i], 10);
    } else if (arg === '--only') {
      args.only = argv[++i];
    } else if (arg === '--only-long') {
      args.onlyLong = true;
    } else if (arg === '--only-short') {
      args.onlyShort = true;
    } else if (arg === '--category') {
      args.category = argv[++i];
    } else if (arg === '--out-dir') {
      args.outDir = argv[++i];
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = parseInt(argv[++i], 10);
    } else if (arg === '--no-cleanup') {
      args.noCleanup = true;
    } else if (arg === '--warmup') {
      args.warmup = argv[++i];
    } else if (arg === '--accumulate') {
      args.accumulate = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}
function printHelp() {
  console.log(`Usage:
  node bench/realworld/bench-pi-realworld.js

Runs Pi against real code-editing tasks with and without memory.
Each task runs N times per side (default ${DEFAULT_RUNS}).

Options:
  --runs N            Number of repetitions per task per side (default ${DEFAULT_RUNS})
  --only TASK_ID      Run a single task
  --only-long         Run only long-horizon tasks
  --only-short        Run only short regression tasks
  --category CAT      Run only tasks of a given category
  --out-dir DIR       Output directory
  --timeout-ms N      Per-side timeout in ms (default ${DEFAULT_TIMEOUT_MS})
  --no-cleanup        Keep worktrees after run (for debugging)
  --warmup FILE       JSON file with warmup prompts to seed memory before tasks
  --accumulate        Memory persists across tasks (simulates real session)
`);
}
function getRepoRoot() {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}
function createWorktree(repoRoot, commitish, worktreePath) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execSync(`git worktree add --detach "${worktreePath}" ${commitish}`, {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}
function removeWorktree(repoRoot, worktreePath) {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 15_000,
    });
  } catch {
    // Best-effort cleanup
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}
function applyPatch(worktreePath, patchPath) {
  const absolutePatch = path.resolve(patchPath);
  execSync(`git apply "${absolutePatch}"`, {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 15_000,
  });
}
function findLapisRoot() {
  const candidates = [
    path.resolve(__dirname, '..', '..'),
    process.env.LAPIS_PATH,
    path.join(os.homedir(), '.pi', 'agent', 'git', 'github.com', 'GeneGulanesJr', 'LaPis'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'memory-store.js'))) {
      return dir;
    }
  }
  // Fallback: use the current repo if it has memory-store.js
  const repoRoot = getRepoRoot();
  if (fs.existsSync(path.join(repoRoot, 'memory-store.js'))) {
    return repoRoot;
  }
  console.error('ERROR: Cannot find LaPis root. Set LAPIS_PATH.');
  process.exit(1);
}
function seedMemory(memorySeedPath, memoryOnHome) {
  if (!memorySeedPath || !fs.existsSync(memorySeedPath)) {
    return;
  }
  const seeds = JSON.parse(fs.readFileSync(memorySeedPath, 'utf-8'));
  if (!Array.isArray(seeds) || seeds.length === 0) {
    return;
  }

  {
const lapisRoot = findLapisRoot(),
    msPath = path.join(lapisRoot, 'memory-store.js');

  for (const seed of seeds) {
    const args = ['save', '--type', seed.type || 'architecture', '--title', seed.title, '--content', seed.content],
    homeEnv = (() => {

      if (seed.project) {
        args.push('--project', seed.project);
      }
      if (seed.scope) {
        args.push('--scope', seed.scope);
      }
  
      
  return (memoryOnHome ? `HOME=${shellQuote(memoryOnHome)} ` : '');
})();execSync(`${homeEnv}node "${msPath}" ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
      cwd: lapisRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
  }
}
}
function prepareNoMemoryHome(outDir) {
  const sourceAgentDir = path.join(os.homedir(), '.pi', 'agent'),
    homeDir = path.join(outDir, '.pi-memory-off-home'),
    targetAgentDir = path.join(homeDir, '.pi', 'agent');
  fs.mkdirSync(targetAgentDir, { recursive: true });

  for (const file of PI_CONFIG_FILES) {
    const source = path.join(sourceAgentDir, file);
    if (fs.existsSync(source)) {
      const target = path.join(targetAgentDir, file);
      if (file === 'settings.json') {
        const settings = JSON.parse(fs.readFileSync(source, 'utf-8'));
        if (Array.isArray(settings.packages)) {
          settings.packages = [];
        }
        fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
      } else {
        fs.copyFileSync(source, target);
      }
    }
  }

  return homeDir;
}
function prepareMemoryOnHome(outDir, taskId) {
  const sourceAgentDir = path.join(os.homedir(), '.pi', 'agent'),
    homeDir = path.join(outDir, `.pi-memory-on-home-${taskId}`),
    targetAgentDir = path.join(homeDir, '.pi', 'agent'),
    targetMemoryDir = path.join(homeDir, '.pi', 'memory');
  fs.mkdirSync(targetAgentDir, { recursive: true });
  fs.mkdirSync(targetMemoryDir, { recursive: true });

  for (const file of PI_CONFIG_FILES) {
    const source = path.join(sourceAgentDir, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(targetAgentDir, file));
    }
  }

  {
const dbPath = path.join(targetMemoryDir, 'memory.db'),
    configContent = JSON.stringify({ db_path: dbPath }, null, 2);
  fs.writeFileSync(path.join(targetMemoryDir, 'config.jsonc'), `${configContent}\n`);

  return homeDir;
}
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function buildPiCommand(homeDir, prompt, outFile) {
  const homePrefix = homeDir ? `HOME=${shellQuote(homeDir)} ` : '';
  return `${homePrefix}pi --print --mode json --no-session ${shellQuote(prompt)} > ${shellQuote(outFile)} 2>&1`;
}
function runCommand(command, cwd, timeoutMs) {
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      settled = false;

    const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
        }
      }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          status: null,
          signal: null,
          elapsed_ms: Date.now() - started,
          stdout,
          stderr,
          error: error.message,
        });
      }
    });

    child.on('close', (status, signal) => {
      if (!settled) {
        settled = true;
      }
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        elapsed_ms: Date.now() - started,
        stdout,
        stderr,
        error: signal === 'SIGTERM' ? `Timed out after ${timeoutMs}ms` : null,
      });
    });
  });
}
function gradeRun(task, worktreePath, parsedOutput) {
  const testResult = runTests(task, worktreePath),
    diffResult = checkDiff(task, worktreePath),
    answerResult = checkAnswer(parsedOutput.answer, task.success?.expected_facts || []),
    trajectoryResult = checkTrajectory(parsedOutput),
    constraintResult = checkConstraints(task, worktreePath);

  return {
    tests: testResult,
    diff: diffResult,
    answer: answerResult,
    trajectory: trajectoryResult,
    constraints: constraintResult,
    overall:
      testResult.passed === testResult.total && testResult.total > 0 && diffResult.passed && constraintResult.passed,
  };
}
function loadTasksFromDir(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const task = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      return task;
    });
}
function loadTasks(tasksDir, opts) {
  const { only, onlyLong, onlyShort, category } = opts || {},
    shortDir = path.join(tasksDir, 'short'),
    longTasks = loadTasksFromDir(tasksDir),
    shortTasks = loadTasksFromDir(shortDir);
  let tasks;
  if (onlyLong && onlyShort) {
    tasks = [...longTasks, ...shortTasks];
  } else if (onlyLong) {
    tasks = longTasks;
  } else if (onlyShort) {
    tasks = shortTasks;
  } else {
    tasks = [...longTasks, ...shortTasks];
  }
  if (only) {
    tasks = tasks.filter((t) => t.id === only);
  }
  if (category) {
    tasks = tasks.filter((t) => t.category === category);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return tasks;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function fmtMs(ms) {
  if (!ms) {
    return 'n/a';
  }
  const s = Math.round(ms / 1000),
  m = !(s < 60) ? (Math.floor(s / 60)) : undefined;
  if (s < 60) {
    return `${s}s`;
  }
  return `${m}m ${s % 60}s`;
}
function fmtNum(n) {
  if (n === undefined || n === null) {
    return 'n/a';
  }
  return n.toLocaleString();
}
function printReport(results) {
  const sides = ['memory-off', 'memory-on'],
    taskIds = [...new Set(results.map((r) => r.task_id))],
    bySide = {};
  for (const side of sides) {
    const sideResults = results.filter((r) => r.side === side),
      solved = sideResults.filter((r) => r.grade.overall).length,
      testPassed = sideResults.filter(
        (r) => r.grade.tests.passed === r.grade.tests.total && r.grade.tests.total > 0,
      ).length,
      activeTokens = sideResults.map((r) => r.usage.active_tokens || 0),
      wallTimes = sideResults.map((r) => r.elapsed_ms || 0),
      toolCalls = sideResults.map((r) => r.behavior?.tool_calls || 0),
      wrongFile = sideResults.filter((r) => !r.grade.diff.passed).length,
      constraintViolations = sideResults.filter((r) => !r.grade.constraints.passed).length,
      trajectoryScores = sideResults.map((r) => r.grade.trajectory?.score || 0).filter((s) => s > 0),
      linesChanged = sideResults.map((r) => r.grade.diff?.linesChanged || 0),
      readEditRatios = sideResults.map((r) => r.grade.trajectory?.readEditRatio || 0).filter((r) => r > 0);

    bySide[side] = {
      solved: `${solved}/${sideResults.length}`,
      testPassed: `${testPassed}/${sideResults.length}`,
      medianTokens: median(activeTokens),
      medianWallTime: median(wallTimes),
      medianToolCalls: median(toolCalls),
      wrongFileEdits: wrongFile,
      constraintViolations,
      medianTrajectoryScore: trajectoryScores.length > 0 ? median(trajectoryScores).toFixed(2) : 'n/a',
      medianLinesChanged: linesChanged.some((l) => l > 0) ? fmtNum(median(linesChanged)) : 'n/a',
      medianReadEditRatio: readEditRatios.length > 0 ? median(readEditRatios).toFixed(2) : 'n/a',
    };
  }

  // Print table
  {
const col1 = 24,
    colN = 12,
  rows = (() => {

    benchLog('');
    benchLog(`╔${'═'.repeat(col1 + 2)}╤${'═'.repeat(colN + 2)}╤${'═'.repeat(colN + 2)}╗`);
    benchLog(`║${'Metric'.padEnd(col1 + 2)}│${'Memory Off'.padStart(colN + 1)} │${'Memory On'.padStart(colN + 1)} ║`);
    benchLog(`╟${'─'.repeat(col1 + 2)}┼${'─'.repeat(colN + 2)}┼${'─'.repeat(colN + 2)}╢`);
  
    
  return ([
    ['Tasks solved', bySide['memory-off'].solved, bySide['memory-on'].solved],
    ['Tests passed', bySide['memory-off'].testPassed, bySide['memory-on'].testPassed],
    ['Median active tokens', fmtNum(bySide['memory-off'].medianTokens), fmtNum(bySide['memory-on'].medianTokens)],
    ['Median wall time', fmtMs(bySide['memory-off'].medianWallTime), fmtMs(bySide['memory-on'].medianWallTime)],
    ['Median tool calls', fmtNum(bySide['memory-off'].medianToolCalls), fmtNum(bySide['memory-on'].medianToolCalls)],
    ['Wrong-file edits', String(bySide['memory-off'].wrongFileEdits), String(bySide['memory-on'].wrongFileEdits)],
    [
      'Constraint violations',
      String(bySide['memory-off'].constraintViolations),
      String(bySide['memory-on'].constraintViolations),
    ],
    [
      'Median trajectory score',
      String(bySide['memory-off'].medianTrajectoryScore),
      String(bySide['memory-on'].medianTrajectoryScore),
    ],
    [
      'Median lines changed',
      String(bySide['memory-off'].medianLinesChanged),
      String(bySide['memory-on'].medianLinesChanged),
    ],
    [
      'Median read-before-edit',
      String(bySide['memory-off'].medianReadEditRatio),
      String(bySide['memory-on'].medianReadEditRatio),
    ],
  ]);
})(); for (const [label, offVal, onVal] of rows) {
    benchLog(
      `║ ${label.padEnd(col1)} ` +
        `│${String(offVal).padStart(colN + 1)} ` +
        `│${String(onVal).padStart(colN + 1)} ` +
        `║`,
    );
  }

  benchLog(`╚${'═'.repeat(col1 + 2)}╧${'═'.repeat(colN + 2)}╧${'═'.repeat(colN + 2)}╝`);
  benchLog('');

  // Per-task detail
  benchLog('Per-task results:');
  for (const taskId of taskIds) {
    for (const side of sides) {
      const taskResults = results.filter((r) => r.task_id === taskId && r.side === side),
        overall = taskResults.filter((r) => r.grade.overall).length,
        tokens = taskResults.map((r) => r.usage.active_tokens || 0),
        tools = taskResults.map((r) => r.behavior?.tool_calls || 0),
        trajScore = taskResults.map((r) => r.grade.trajectory?.score || 0),
        constraints = taskResults.filter((r) => !r.grade.constraints.passed).length,
        lines = taskResults.map((r) => r.grade.diff?.linesChanged || 0);
      benchLog(
        `  ${taskId} (${side}): ${overall}/${taskResults.length} solved, ` +
          `median ${fmtNum(median(tokens))} tokens, ${fmtNum(median(tools))} tools, ` +
          `traj=${median(trajScore).toFixed(2)}, lines=${fmtNum(median(lines))}, ` +
          `constraint_violations=${constraints}`,
      );
    }
  }
}
}
