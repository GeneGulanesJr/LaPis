'use strict';

/**
 * Claude Code bridge: relevance filter for the UserPromptSubmit memory context.
 *
 * The prompt hook injects three candidate lists — prompt-matched memories,
 * cross-project suggestions and the preflight code entries — that are matched
 * lexically and are often unrelated to the prompt. When the judgment layer is
 * on (provider 'decision' + LIQUID_API_KEY, surface 'context' not disabled)
 * this module:
 *   1. drops preflight entries whose file does not exist on disk (a code index
 *      built on another machine points at paths that are not here), then
 *   2. asks the decision judge, in ONE request, how likely each remaining
 *      candidate is relevant to the prompt (judgePromptRelevance in
 *      src/memory-domain/context-decision.js) and drops those below
 *      judgment.prompt_filter_threshold.
 * Any failure returns null and the caller renders exactly today's output.
 * One JSON line per prompt (counts, probabilities, latency — no memory text)
 * goes to the judgment log (see judgmentLogPath).
 */

const fs = require('node:fs'),
  path = require('node:path'),
  TITLE_CHARS = 160,
  SIGNATURE_CHARS = 200;

function cap(text, n) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

/** True when `file` exists — absolute as-is, relative against any base dir. */
function fileExists(file, baseDirs = []) {
  if (typeof file !== 'string' || file.length === 0) {
    return false;
  }
  if (path.isAbsolute(file)) {
    return fs.existsSync(file);
  }
  return baseDirs.some((dir) => typeof dir === 'string' && dir && fs.existsSync(path.join(dir, file)));
}

/** Entries without a file are kept; entries whose file is missing are dropped. */
function keepExisting(entries, baseDirs, fileOf) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((entry) => {
    const file = fileOf(entry);
    return !file || fileExists(file, baseDirs);
  });
}

/**
 * Deterministic pre-filter: a copy of a preflight result without the
 * duplicate warnings, code entries and related files whose path is missing.
 * Returns { result, dropped } (dropped = number of entries removed).
 */
function prefilterPreflight(result, baseDirs) {
  if (!result || result.error) {
    return { result, dropped: 0 };
  }
  const warnings = keepExisting(result.duplicate_warnings, baseDirs, (w) => w && w.file),
    code = keepExisting(result.likely_existing_code, baseDirs, (c) => c && c.file),
    related = keepExisting(result.related_files, baseDirs, (f) => f),
    dropped =
      (result.duplicate_warnings || []).length -
      warnings.length +
      ((result.likely_existing_code || []).length - code.length) +
      ((result.related_files || []).length - related.length);
  return {
    result: { ...result, duplicate_warnings: warnings, likely_existing_code: code, related_files: related },
    dropped,
  };
}

/**
 * Coding context without missing paths: the whole block is dropped (null)
 * when its target file is missing; related files and likely tests lose
 * their missing entries.
 */
function prefilterCodingContext(result, baseDirs) {
  if (!result || result.error) {
    return result;
  }
  const targetFile = result.target && result.target.file;
  if (targetFile && !fileExists(targetFile, baseDirs)) {
    return null;
  }
  return {
    ...result,
    related_files: keepExisting(result.related_files, baseDirs, (f) => f),
    likely_tests: keepExisting(result.likely_tests, baseDirs, (t) => t && t.file),
  };
}

/**
 * Risk + recommended action after entries were removed. Mirrors the
 * templates of recommendedAction() in src/agent-intel/preflight.js (not
 * required here: that module pulls the whole search stack into the hook).
 */
function finalizePreflight(original, filtered) {
  const warnings = filtered.duplicate_warnings || [],
    code = filtered.likely_existing_code || [],
    related = filtered.related_files || [],
    unchanged =
      warnings.length === (original.duplicate_warnings || []).length &&
      code.length === (original.likely_existing_code || []).length &&
      related.length === (original.related_files || []).length;
  if (unchanged) {
    return original;
  }
  if (warnings.length === 0 && code.length === 0 && related.length === 0) {
    // Nothing left: appendPreflightBlock renders nothing for low risk + no entries.
    return { ...filtered, risk: 'low', recommended_action: null };
  }
  let { risk } = filtered,
    action = 'Review the related files and memories before editing.';
  if (warnings.length > 0) {
    action = `Review and extend existing ${warnings[0].symbol} in ${warnings[0].file} before creating new code.`;
  } else if (code.length > 0) {
    action = `Start from ${code[0].symbol} in ${code[0].file}; confirm whether it already owns this behavior.`;
  }
  if (warnings.length === 0 && (original.duplicate_warnings || []).length > 0 && risk === 'high') {
    risk = 'medium';
  }
  return { ...filtered, risk, recommended_action: action };
}

function codeKey(entry) {
  return `${entry && entry.symbol}\u0000${entry && entry.file}`;
}

/**
 * Build the judge candidates. Memories, suggestions, code entries (a warning
 * and a code item for the same symbol+file are ONE candidate) and related
 * files. Returns { candidates, refs } — refs[i] says which list entry i is.
 */
function buildCandidates({ memories, suggestions, preflight, summarize }) {
  const candidates = [],
    refs = [];
  for (const o of memories) {
    const snippet = summarize(o.content);
    candidates.push({
      kind: 'memory',
      fields: { title: cap(o.title || '', TITLE_CHARS), type: o.type || '', ...(snippet ? { snippet } : {}) },
    });
    refs.push({ kind: 'memory', id: o.id });
  }
  for (const s of suggestions) {
    candidates.push({
      kind: 'suggestion',
      fields: { title: cap(s.title || '', TITLE_CHARS), type: s.type || '', project: s.project || '' },
    });
    refs.push({ kind: 'suggestion', id: s.id });
  }
  if (preflight && !preflight.error) {
    const codeIndex = new Map();
    for (const entry of [...(preflight.duplicate_warnings || []), ...(preflight.likely_existing_code || [])]) {
      const key = codeKey(entry);
      if (codeIndex.has(key)) {
        // Prefer the richer code item fields when a warning came first.
        const existing = candidates[codeIndex.get(key)];
        if (entry.signature && !existing.fields.signature) {
          existing.fields.signature = cap(entry.signature, SIGNATURE_CHARS);
        }
        continue;
      }
      codeIndex.set(key, candidates.length);
      candidates.push({
        kind: 'code',
        fields: {
          symbol: entry.symbol || '',
          ...(entry.kind ? { kind: entry.kind } : {}),
          file: entry.file || '',
          ...(entry.signature ? { signature: cap(entry.signature, SIGNATURE_CHARS) } : {}),
        },
      });
      refs.push({ kind: 'code', key });
    }
    for (const file of preflight.related_files || []) {
      candidates.push({ kind: 'file', fields: { file } });
      refs.push({ kind: 'file', file });
    }
  }
  return { candidates, refs };
}

// The log writer is shared with the other judgment surfaces (src/judgment/log.js).
const { judgmentLogPath, writeJudgmentLog } = require('../judgment/log');

function countByKind(refs, keep) {
  const kept = { memory: 0, suggestion: 0, code: 0, file: 0 },
    dropped = { memory: 0, suggestion: 0, code: 0, file: 0 };
  refs.forEach((ref, i) => {
    (keep[i] ? kept : dropped)[ref.kind] += 1;
  });
  return { kept, dropped };
}

/**
 * FilterPromptContext({ prompt, bag, preflight, baseDirs }, opts)
 *   bag:       collectContext() bag (effectiveObservations, crossProjectSuggestions)
 *   preflight: raw preflight dispatch result or null
 *   baseDirs:  directories relative preflight paths resolve against
 *   opts:      { judge?: judgePromptRelevance-compatible fn, judgeArgs?, log?, now? }
 * Returns { bag, preflight } with irrelevant candidates removed, or null on
 * any failure (the caller then renders the unfiltered inputs).
 */
async function filterPromptContext({ prompt, bag, preflight, baseDirs = [] }, opts = {}) {
  const now = opts.now || Date.now,
    log = opts.log || writeJudgmentLog,
    started = now(),
    record = { ts: new Date(started).toISOString(), surface: 'context', hook: 'UserPromptSubmit' };
  try {
    const contextDecision = require('../memory-domain/context-decision'),
      judge = opts.judge || contextDecision.judgePromptRelevance,
      { threshold } = contextDecision.promptFilterSettings(),
      { summarizeMemoryContent } = require('../hooks-engine/context-builder'),
      memories = bag ? bag.effectiveObservations || [] : [],
      suggestions = bag ? bag.crossProjectSuggestions || [] : [],
      pre = prefilterPreflight(preflight, baseDirs),
      { candidates, refs } = buildCandidates({
        memories,
        suggestions,
        preflight: pre.result,
        summarize: summarizeMemoryContent,
      });
    record.threshold = threshold;
    record.missing_paths = pre.dropped;

    let keep = [];
    if (candidates.length > 0) {
      const res = await judge(prompt, candidates, opts.judgeArgs || {});
      if (!res || res.status !== 'ok' || !Array.isArray(res.p) || res.p.length !== candidates.length) {
        log({
          ...record,
          status: 'unavailable',
          reason: cap(String((res && res.reason) || 'no result'), 200),
          ms: now() - started,
        });
        return null;
      }
      keep = res.p.map((p) => p >= threshold);
      record.p = refs.map((ref, i) => ({
        kind: ref.kind,
        ...(ref.id !== undefined ? { id: ref.id } : {}),
        p: Math.round(res.p[i] * 1000) / 1000,
      }));
    }

    const keptMemoryIds = new Set(),
      keptSuggestionIds = new Set(),
      keptCode = new Set(),
      keptFiles = new Set();
    refs.forEach((ref, i) => {
      if (!keep[i]) {
        return;
      }
      if (ref.kind === 'memory') {
        keptMemoryIds.add(i);
      } else if (ref.kind === 'suggestion') {
        keptSuggestionIds.add(i);
      } else if (ref.kind === 'code') {
        keptCode.add(ref.key);
      } else {
        keptFiles.add(ref.file);
      }
    });

    let memoryIndex = 0,
      suggestionIndex = memories.length;
    const nextBag = bag
        ? {
            ...bag,
            effectiveObservations: memories.filter(() => keptMemoryIds.has(memoryIndex++)),
            crossProjectSuggestions: suggestions.filter(() => keptSuggestionIds.has(suggestionIndex++)),
          }
        : bag,
      filteredPreflight =
        pre.result && !pre.result.error
          ? finalizePreflight(preflight, {
              ...pre.result,
              duplicate_warnings: pre.result.duplicate_warnings.filter((w) => keptCode.has(codeKey(w))),
              likely_existing_code: pre.result.likely_existing_code.filter((c) => keptCode.has(codeKey(c))),
              related_files: pre.result.related_files.filter((f) => keptFiles.has(f)),
            })
          : preflight,
      { kept, dropped } = countByKind(refs, keep);

    log({ ...record, status: candidates.length > 0 ? 'ok' : 'no-candidates', kept, dropped, ms: now() - started });
    return { bag: nextBag, preflight: filteredPreflight };
  } catch (e) {
    log({ ...record, status: 'error', reason: cap(String(e && e.message), 200), ms: now() - started });
    return null;
  }
}

module.exports = {
  filterPromptContext,
  prefilterPreflight,
  prefilterCodingContext,
  finalizePreflight,
  buildCandidates,
  fileExists,
  judgmentLogPath,
  writeJudgmentLog,
};
