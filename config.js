const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CONFIG_DIR = path.join(HOME, '.pi', 'memory');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.jsonc');

const DEFAULTS = {
  db_path: path.join(HOME, '.pi', 'memory', 'memory.db'),
  wal_autocheckpoint: 1000,
  busy_timeout_ms: 5000,
  ranking: {
    fts_relevance: 0.4,
    recency: 0.3,
    trust: 0.15,
    recall: 0.15,
  },
  dedup: {
    auto_merge_threshold: 0.85,
    warning_threshold: 0.60,
  },
  compact_every_n_sessions: 5,
  context_limit: 5, // Used by memory-store.js context command — do not remove
  tier_config_path: path.join(HOME, '.pi', 'memory', 'tier.jsonc'),
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function stripJsoncComments(raw) {
  let result = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') {j++;}
        j++;
      }
      result += raw.slice(i, j + 1);
      i = j + 1;
    } else if (raw[i] === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') {i++;}
    } else if (raw[i] === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {i++;}
      i += 2;
    } else {
      result += raw[i];
      i++;
    }
  }
  return result;
}

function expandTilde(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) {
    return path.join(HOME, p.slice(1));
  }
  return p;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cleaned = stripJsoncComments(raw);
    const userConfig = JSON.parse(cleaned);
    const merged = deepMerge(DEFAULTS, userConfig);
    merged.db_path = expandTilde(merged.db_path);
    merged.tier_config_path = expandTilde(merged.tier_config_path);
    return merged;
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error(`[config] Invalid JSON in ${CONFIG_PATH}: ${e.message}`);
    } else if (e.code !== 'ENOENT') {
      console.error(`[config] Error reading ${CONFIG_PATH}: ${e.message}`);
    }
    return { ...DEFAULTS };
  }
}

function getConfig() {
  if (!getConfig._cached) {
    getConfig._cached = loadConfig();
  }
  return getConfig._cached;
}

function resetConfigCache() {
  getConfig._cached = null;
}

module.exports = { getConfig, loadConfig, resetConfigCache, stripJsoncComments, expandTilde, deepMerge, DEFAULTS, CONFIG_PATH };
