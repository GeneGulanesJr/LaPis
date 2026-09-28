'use strict';

/**
 * Claude Code bridge: automatic background indexing of unindexed repos.
 *
 * Guardrails only fire inside an indexed repo, so an unindexed repo used to be
 * silently skipped — the agent never got `memory-code` and never knew why. This
 * module closes that gap: when a hook sees a git repo that is not indexed, it
 * starts `lapis index-repo` as a DETACHED child and returns immediately, so the
 * hook budget is never spent on indexing itself. Once the child finishes the
 * repo shows up in code_repos and every guardrail starts applying on its own.
 *
 * Safety rails:
 *   - opt-out via config `auto_index.enabled: false` or env LAPIS_AUTO_INDEX=0
 *   - only directories inside a git work tree; never $HOME, the fs root or tmp
 *   - a marker file per repo root (claimed with O_EXCL) so parallel hooks and
 *     concurrent sessions never spawn two indexers; a cooldown stops a failing
 *     indexer from being respawned on every tool call
 *   - everything is best-effort: any error degrades to "do nothing"
 */

const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  { spawn } = require('node:child_process'),
  { resolveIndexedRepo, normalizeRepoPath } = require('../hooks-engine/project'),
  // A live indexer younger than this is treated as still running.
  IN_PROGRESS_MS = 30 * 60 * 1000,
  // How long a bare claim (no pid yet) is trusted before it is considered crashed.
  CLAIM_MS = 30 * 1000,
  // After a spawn, do not retry for this long unless the indexer is still alive.
  COOLDOWN_MS = 10 * 60 * 1000;

function lapisHome(env = process.env) {
  return env.LAPIS_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function defaultMarkerDir(env = process.env) {
  return path.join(lapisHome(env), '.pi', 'memory', 'auto-index');
}

/** Directories that must never be auto-indexed as a repo root. */
function excludedRoots(env = process.env) {
  const dirs = [os.homedir(), env.HOME, env.USERPROFILE, env.LAPIS_HOME, os.tmpdir()];
  return new Set(dirs.filter(Boolean).map(normalizeRepoPath));
}

/**
 * Walk up from `start` to the nearest directory containing `.git` (dir or
 * worktree/submodule file). Returns null outside a git work tree, or when the
 * walk reaches an excluded directory first ($HOME, tmp, fs root).
 */
function findRepoRoot(start, env = process.env) {
  const excluded = excludedRoots(env);
  let dir = path.resolve(start);
  for (;;) {
    if (excluded.has(normalizeRepoPath(dir)) || dir === path.parse(dir).root) {
      return null;
    }
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function isEnabled(config) {
  return !config || !config.auto_index || config.auto_index.enabled !== false;
}

function markerFile(dir, repoRoot) {
  const hash = crypto.createHash('sha1').update(normalizeRepoPath(repoRoot)).digest('hex').slice(0, 16);
  return path.join(dir, `${hash}.json`);
}

function readMarker(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Spawn `cli.js index-repo` detached, logging to <markerDir>/<name>.log. */
function spawnDetachedIndex({ repoRoot, name, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  try {
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, '../../cli.js'), 'index-repo', '--path', repoRoot, '--name', name],
      { detached: true, stdio: ['ignore', out, out], windowsHide: true },
    );
    // An async spawn failure (ENOENT etc.) must not crash the hook process.
    child.on('error', () => {});
    child.unref();
    return child;
  } finally {
    fs.closeSync(out);
  }
}

/**
 * Start a background index for the git repo containing `cwd` when it is not
 * indexed yet.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {object[]} opts.repos          indexed repos (rows of code_repos)
 * @param {string|null} [opts.currentProject]
 * @param {object} [opts.config]         defaults to getConfig()
 * @param {object} [opts.env]
 * @param {number} [opts.now]
 * @param {string} [opts.dir]            marker/log directory
 * @param {Function} [opts.spawnIndex]   injectable for tests
 * @param {Function} [opts.isAlive]      injectable for tests
 * @returns {{status: string, repoRoot?: string, name?: string, logFile?: string, pid?: number}}
 *   status: disabled | indexed | not-a-repo | started | in-progress | cooldown | error
 */
function maybeStartAutoIndex(opts) {
  const env = opts.env || process.env;
  try {
    const config = opts.config || require('../../config').getConfig();
    if (!isEnabled(config)) {
      return { status: 'disabled' };
    }
    if (resolveIndexedRepo(opts.cwd, opts.repos || [], opts.currentProject)) {
      return { status: 'indexed' };
    }
    const repoRoot = findRepoRoot(opts.cwd, env);
    if (!repoRoot) {
      return { status: 'not-a-repo' };
    }
    // A repo whose root (not just cwd) is already indexed, or whose name is taken
    // by an indexed repo, is treated as indexed — same rule the guardrails use.
    const name = path.basename(repoRoot);
    if (resolveIndexedRepo(repoRoot, opts.repos || [], name)) {
      return { status: 'indexed' };
    }

    const dir = opts.dir || defaultMarkerDir(env),
      file = markerFile(dir, repoRoot),
      logFile = path.join(dir, `${name.replace(/[^\w.-]/g, '_')}.log`),
      now = opts.now ?? Date.now(),
      alive = opts.isAlive || isProcessAlive,
      info = { repoRoot, name, logFile };

    fs.mkdirSync(dir, { recursive: true });
    const existing = readMarker(file);
    if (existing) {
      const age = now - (existing.startedAt || 0),
        // pid === null: another hook just claimed the marker and is mid-spawn.
        // A failed spawn is recorded explicitly so it is never mistaken for that.
        claiming = existing.pid == null && !existing.failed && age < CLAIM_MS,
        running = existing.pid != null && age < IN_PROGRESS_MS && alive(existing.pid);
      if (claiming || running) {
        return { status: 'in-progress', ...info, pid: existing.pid || undefined };
      }
      if (age < COOLDOWN_MS) {
        return { status: 'cooldown', ...info };
      }
      fs.rmSync(file, { force: true });
    }

    // O_EXCL claim: exactly one concurrent hook wins and spawns.
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: null, startedAt: now, repoRoot }), { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') {
        return { status: 'in-progress', ...info };
      }
      throw e;
    }
    try {
      const child = (opts.spawnIndex || spawnDetachedIndex)({ repoRoot, name, logFile });
      fs.writeFileSync(file, JSON.stringify({ pid: child.pid || null, startedAt: now, repoRoot }));
      return { status: 'started', ...info, pid: child.pid };
    } catch (e) {
      // Keep a failed marker: the cooldown stops a broken spawn retrying every call.
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: null, failed: true, startedAt: now, repoRoot }));
      } catch {
        // Best-effort.
      }
      process.stderr.write(`claude-code: auto-index spawn failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return { status: 'error', ...info };
    }
  } catch (e) {
    process.stderr.write(`claude-code: auto-index skipped: ${e instanceof Error ? e.message : String(e)}\n`);
    return { status: 'error' };
  }
}

/**
 * Agent-facing note for an auto-index result, or null when there is nothing
 * worth saying (indexed / disabled / not a repo).
 */
function describeAutoIndex(result) {
  if (!result || !result.repoRoot) {
    return null;
  }
  const manual = `\`memory-code index-repo --path ${result.repoRoot} --name ${result.name}\``;
  switch (result.status) {
    case 'started':
      return (
        `LaPis: repo "${result.name}" was not indexed. Auto-indexing started in the background ` +
        `(log: ${result.logFile}). Until it finishes \`memory-code\` has no data for this repo, so ` +
        `Read/Grep/Glob work normally for now; once it completes, prefer \`memory-code outline/search/callers\`.`
      );
    case 'in-progress':
      return (
        `LaPis: repo "${result.name}" is being indexed in the background (log: ${result.logFile}). ` +
        `Use Read/Grep/Glob until it completes, then prefer \`memory-code\`.`
      );
    case 'cooldown':
    case 'error':
      return (
        `LaPis: repo "${result.name}" is not indexed and the automatic attempt did not complete ` +
        `(see ${result.logFile}). Index it manually with ${manual} before exploring the code.`
      );
    default:
      return null;
  }
}

module.exports = {
  maybeStartAutoIndex,
  describeAutoIndex,
  findRepoRoot,
  isEnabled,
  markerFile,
  defaultMarkerDir,
  spawnDetachedIndex,
  IN_PROGRESS_MS,
  COOLDOWN_MS,
};
