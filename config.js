const path = require('path'),
  fs = require('fs'),
  os = require('os'),
  HOME = process.env.LAPIS_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir(),
  CONFIG_DIR = path.join(HOME, '.pi', 'memory'),
  CONFIG_PATH = path.join(CONFIG_DIR, 'config.jsonc'),
  DEFAULTS = {
    db_path: path.join(HOME, '.pi', 'memory', 'memory.db'),
    wal_autocheckpoint: 1000,
    busy_timeout_ms: 30000,
    busy_retry_max: 5,
    ranking: {
      fts_relevance: 0.4,
      recency: 0.3,
      trust: 0.15,
      recall: 0.15,
    },
    dedup: {
      auto_merge_threshold: 0.85,
      warning_threshold: 0.6,
    },
    compact_every_n_sessions: 5,
    context_limit: 5, // Used by memory-store.js context command — do not remove
    tier_config_path: path.join(HOME, '.pi', 'memory', 'tier.jsonc'),
    // Auto-switch `index-repo` to async when file count exceeds this threshold.
    // Override with the LAPIS_ASYNC_INDEX_THRESHOLD env var or via config.jsonc.
    async_index_file_threshold: 500,
    http_api_key: null,
    output_compression: {
      enabled: true, // Master toggle — set false to disable auto-compression
      min_chars: 2000, // Don't compress output shorter than this
      min_savings_percent: 30, // Don't replace if savings < this %
    },
    tool_guardrails: {
      enabled: true, // Master toggle — set false to disable raw grep/find + unread-file guardrails
    },
    // Provider-agnostic semantic judgments (docs/JUDGMENT.md, spec 2026-09-26).
    // DEFAULT OFF — LaPis is zero-cloud/zero-keys by identity (spec §4);
    // opting in requires LAPIS_JUDGE_PROVIDER=jev AND a machine-scoped
    // TYPESAFE_API_KEY. Off = every call site keeps its heuristic fallback.
    judgment: {
      provider: 'heuristic', // 'heuristic' | 'jev' | 'off'
      timeout_ms: 5000,
      max_retries: 2,
      local_only: false, // kill switch: force heuristic path everywhere
      confident_threshold: 0.6,
      breaker_threshold: 3, // consecutive failures before the breaker opens
      breaker_cooldown_ms: 60000,
      disables: {}, // per-surface opt-outs, e.g. { dream: true }
    },
  };

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// Known tool tiers (gateway.js maps them to command sets). An unknown tier
// Must fail closed, not silently degrade to unrestricted (#302).
const KNOWN_TIERS = new Set(['core', 'standard', 'full']);

/**
 * Read the tier config (JSONC). ENOENT keeps the out-of-box unrestricted
 * default; ANY other problem — invalid JSON (including the old bug of `//`
 * inside URL strings truncating the document), a non-object, a missing
 * tier, or an unknown tier name — warns and fails CLOSED to the strictest
 * tier instead of the old silent fail-open to 'full' (#302).
 */
function readTierConfig() {
  try {
    const configPath = getConfig().tier_config_path,
      raw = fs.readFileSync(configPath, 'utf-8'),
      parsed = JSON.parse(stripJsoncComments(raw));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.tier !== 'string' ||
      !KNOWN_TIERS.has(parsed.tier.trim())
    ) {
      throw new Error('tier_config must be an object with a known "tier" (core|standard|full)');
    }
    return { tier: parsed.tier.trim() };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { tier: 'full' };
    }
    console.warn(`[config] tier config unavailable (${e.message}); failing closed to 'core'`);
    return { tier: 'core' };
  }
}

function stripJsoncComments(raw) {
  let result = '',
    i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') {
          j++;
        }
        j++;
      }
      result += raw.slice(i, j + 1);
      i = j + 1;
    } else if (raw[i] === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') {
        i++;
      }
    } else if (raw[i] === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        i++;
      }
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

// Apply documented environment-variable overrides. Precedence:
//   Env var > config.jsonc value > DEFAULTS.
// Add future env overrides here so they all flow through getConfig()'s cache.
function applyEnvOverrides(config) {
  const raw = process.env.LAPIS_ASYNC_INDEX_THRESHOLD;
  if (raw !== undefined && raw !== '') {
    // Accept only clean positive integers (e.g. "500"), not "3.7" or "1e3".
    if (/^\d+$/.test(raw.trim())) {
      const parsed = parseInt(raw, 10);
      if (parsed > 0) {
        config.async_index_file_threshold = parsed;
      }
    }
  }
  const j = config.judgment || (config.judgment = {});
  if (process.env.LAPIS_JUDGE_PROVIDER) j.provider = process.env.LAPIS_JUDGE_PROVIDER;
  if (process.env.LAPIS_JUDGE_TIMEOUT_MS) {
    const n = parseInt(process.env.LAPIS_JUDGE_TIMEOUT_MS, 10);
    if (Number.isFinite(n)) j.timeout_ms = n;
  }
  if (process.env.LAPIS_JUDGE_LOCAL_ONLY === '1' || process.env.LAPIS_JUDGE_LOCAL_ONLY === 'true') {
    j.local_only = true;
  }
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^LAPIS_JUDGE_DISABLE_([A-Z0-9_]+)$/.exec(k);
    if (m && (v === '1' || v === 'true')) {
      j.disables = j.disables || {};
      j.disables[m[1].toLowerCase()] = true;
    }
  }
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8'),
      cleaned = stripJsoncComments(raw),
      userConfig = JSON.parse(cleaned),
      merged = deepMerge(DEFAULTS, userConfig);
    merged.db_path = expandTilde(merged.db_path);
    merged.tier_config_path = expandTilde(merged.tier_config_path);
    applyEnvOverrides(merged);
    return merged;
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error(`[config] Invalid JSON in ${CONFIG_PATH}: ${e.message}`);
    } else if (e.code !== 'ENOENT') {
      console.error(`[config] Error reading ${CONFIG_PATH}: ${e.message}`);
    }
    // deepMerge (not { ...DEFAULTS }): the fallback must deep-copy nested
    // sections — applyEnvOverrides mutates config.judgment.disables etc., and a
    // shallow copy would leak those mutations into the shared DEFAULTS object.
    const fallback = deepMerge(DEFAULTS, {});
    applyEnvOverrides(fallback);
    return fallback;
  }
}

let _configMtime = 0;

function getConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (getConfig._cached && stat.mtimeMs <= _configMtime) {
      return getConfig._cached;
    }
    _configMtime = stat.mtimeMs;
  } catch {}
  if (getConfig._cached && !_configMtime) {
    return getConfig._cached;
  }
  getConfig._cached = loadConfig();
  return getConfig._cached;
}

function resetConfigCache() {
  getConfig._cached = null;
}

module.exports = {
  getConfig,
  loadConfig,
  resetConfigCache,
  stripJsoncComments,
  expandTilde,
  deepMerge,
  applyEnvOverrides,
  DEFAULTS,
  CONFIG_PATH,
  readTierConfig,
};
