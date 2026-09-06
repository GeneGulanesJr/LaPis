const { getConfig } = require('../../config');
const { CAPTURE_PASSIVE } = require('../../constants');
const { parseExpiresIn } = require('./ttl');

function save(deps, args) {
  const {
    jsonErrNoExit,
    insertObservation,
    insertObservationRelation,
    softDeleteObservation,
    checkDuplicate,
    findLatestSession,
  } = deps;

  const title = args.title;
  const type = args.type || 'manual';
  const content = args.content;
  const project = args.project || null;
  const scope = args.scope || 'project';
  const topicKey = args['topic-key'] || null;
  const sessionId = args['session-id'] || findLatestSession(project);
  const force = args.force === 'true' || args.force === true;

  const expiresIn = args['expires-in'] || args.expiresIn || null;
  let expiresAt = null;
  if (expiresIn !== null && expiresIn !== undefined && expiresIn !== '') {
    expiresAt = parseExpiresIn(expiresIn);
    if (expiresAt === null) {
      return jsonErrNoExit(`Invalid --expires-in value: ${expiresIn}. Use formats like "7d", "2w", "1m", "12h".`);
    }
  }

  const missing = [];
  if (!title) {
    missing.push('--title');
  }
  if (!content) {
    missing.push('--content');
  }
  if (missing.length > 0) {
    return jsonErrNoExit(`Missing ${missing.join(' and ')}`);
  }

  if (!force) {
    const dupes = checkDuplicate(title, type, project, topicKey);
    if (dupes.potential_duplicates.length > 0) {
      const bestMatch = dupes.potential_duplicates[0];
      const dedupCfg = getConfig().dedup;
      if (bestMatch.similarity >= dedupCfg.auto_merge_threshold) {
        const rows = insertObservation({ sessionId, type, title, content, project, scope, topicKey, expiresAt });
        const newId = rows[0].id;
        insertObservationRelation({
          sourceId: newId,
          targetId: bestMatch.id,
          relation: 'duplicate',
          confidence: bestMatch.similarity,
        });
        softDeleteObservation(bestMatch.id);
        return {
          id: newId,
          title,
          created_at: rows[0].created_at,
          expires_at: rows[0].expires_at,
          auto_merged: true,
          superseded_id: bestMatch.id,
          superseded_title: bestMatch.title,
          similarity: bestMatch.similarity,
        };
      }
      return {
        status: 'potential_duplicate',
        message: 'Similar observations exist. Use --force to save anyway.',
        matches: dupes.potential_duplicates.slice(0, 3),
        hint: 'save --force ...',
      };
    }
  }

  const rows = insertObservation({ sessionId, type, title, content, project, scope, topicKey, expiresAt });
  return { id: rows[0].id, title, created_at: rows[0].created_at, expires_at: rows[0].expires_at };
}

function capturePassive(deps, args) {
  const { jsonErrNoExit, insertCapturePassiveObservation, findLatestSession } = deps;
  const content = args.content;
  if (!content) {
    return jsonErrNoExit('Missing --content');
  }

  const match = content.match(/##\s*Key\s*Learnings?:\s*([\s\S]*)/i);
  if (!match) {
    return { extracted: 0, items: [] };
  }

  const section = match[1];
  const itemRe = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*([^\n]*(?:\n(?!\s*(?:[-*]|\d+[.)])\s*)[^\n]*)*)/g;
  const items = [];
  let m;
  while ((m = itemRe.exec(section)) !== null) {
    const cleaned = m[1].replace(/\n\s+/g, ' ').trim();
    if (cleaned) {
      items.push(cleaned);
    }
  }

  let inserted = 0;
  const sessionId = findLatestSession(null);
  for (const item of items) {
    const summary =
      item.length > CAPTURE_PASSIVE.SUMMARY_MAX_LENGTH
        ? `${item.slice(0, CAPTURE_PASSIVE.SUMMARY_MAX_LENGTH - 3)}…`
        : item;
    insertCapturePassiveObservation({ sessionId, summary, content: item });
    inserted++;
  }
  return { extracted: inserted, items };
}

function suggestTopicKey(args) {
  const title = args.title;
  const content = args.content;
  const source = title || content || '';
  const key = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return { topic_key: key || 'untitled' };
}

module.exports = { save, capturePassive, suggestTopicKey };
