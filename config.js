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

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const userConfig = JSON.parse(cleaned);
    return deepMerge(DEFAULTS, userConfig);
  } catch {
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

module.exports = { getConfig, loadConfig, resetConfigCache, DEFAULTS, CONFIG_PATH };
