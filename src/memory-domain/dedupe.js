const { DEDUP, RESULT_LIMITS } = require('../../constants'), { getConfig } = require('../../config');


function trigramOverlap(a, b) {
  const trigrams = (s) => {
      const t = new Set(),
        lower = s.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (let i = 0; i <= lower.length - 3; i++) {
        t.add(lower.slice(i, i + 3));
      }
      return t;
    },
    ta = trigrams(a),
    tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) {
    return 1.0;
  }
  if (ta.size === 0 || tb.size === 0) {
    return 0.0;
  }
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      shared++;
    }
  }
  return shared / Math.max(ta.size, tb.size);
}

function checkDuplicate(deps, title, type, project, topicKey) {
  const { sqlJson } = deps, params = [type];
  let q = `
    SELECT id, title, topic_key, created_at
    FROM observations
    WHERE type = ? AND deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `;
  
  if (project) {
    q += ' AND project = ?';
    params.push(project);
  }
  if (topicKey) {
    q += ' ORDER BY CASE WHEN topic_key = ? THEN 0 ELSE 1 END, created_at DESC';
    params.push(topicKey);
  } else {
    q += ' ORDER BY created_at DESC';
  }
  q += ` LIMIT ${RESULT_LIMITS.DEDUP_CANDIDATES}`;
  {
const candidates = sqlJson(q, params),
    duplicates = [],
    warningThreshold = getConfig().dedup.warning_threshold;
  for (const c of candidates) {
    const score = trigramOverlap(title, c.title);
    if (score >= warningThreshold) {
      duplicates.push({
        id: c.id,
        title: c.title,
        similarity: Math.round(score * 100) / 100,
        created_at: c.created_at,
      });
    }
  }
  return { potential_duplicates: duplicates };
}
}

function markDuplicate(deps, args) {
  const { sqlRun, softDeleteObservation } = deps,
    source = parseInt(args.source),
    target = parseInt(args.target),
    confidence = parseFloat(args.confidence || String(DEDUP.MARK_DUP_DEFAULT_CONFIDENCE));
  if (!source || !target) {
    return { error: 'Missing --source and --target' };
  }
  if (source === target) {
    return { error: 'Source and target must be different observations' };
  }

  sqlRun(
    'INSERT OR REPLACE INTO observation_relations (source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?)',
    [source, target, 'duplicate', confidence],
  );
  softDeleteObservation(target);
  return { ok: true, merged: { kept: source, removed: target } };
}

module.exports = { trigramOverlap, checkDuplicate, markDuplicate };
