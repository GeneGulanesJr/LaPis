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

const WS_CHAR = /\s/;

function skipWsWhile(section, i) {
  while (i < section.length && WS_CHAR.test(section[i])) {
    i++;
  }
  return i;
}

// Length of the list marker (`-`, `*`, `N.` or `N)`) at section[i], or 0.
function bulletLengthAt(section, i) {
  const ch = section[i];
  if (ch === '-' || ch === '*') {
    return 1;
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < section.length && section[j] >= '0' && section[j] <= '9') {
      j++;
    }
    if (j < section.length && (section[j] === '.' || section[j] === ')')) {
      return j - i + 1;
    }
  }
  return 0;
}

// Extract list items from a "Key Learnings" section — linear-time equivalent
// of the former polynomial-ReDoS item regex
// /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*([^\n]*(?:\n(?!\s*(?:[-*]|\d+[.)])\s*)[^\n]*)*)/g.
// An item starts at a (possibly indented, possibly preceded by blank lines)
// `-`, `*`, `N.` or `N)` marker and spans every following line that does not
// itself begin with a marker.
function extractLearningItems(section) {
  const items = [];
  const n = section.length;
  let anchor = 0;
  while (anchor < n) {
    // The old regex could only anchor at the string start or after a newline.
    if (anchor !== 0 && section[anchor] !== '\n') {
      anchor++;
      continue;
    }
    const bulletAt = skipWsWhile(section, anchor === 0 ? 0 : anchor + 1);
    const mark = bulletLengthAt(section, bulletAt);
    if (mark === 0) {
      // No marker: every candidate anchor inside the skipped whitespace run
      // lands on this same non-marker position, so jump past it.
      anchor = bulletAt > anchor ? bulletAt : anchor + 1;
      continue;
    }
    const start = skipWsWhile(section, bulletAt + mark);
    let end = start;
    for (;;) {
      const nl = section.indexOf('\n', end);
      if (nl === -1) {
        end = n;
        break;
      }
      if (bulletLengthAt(section, skipWsWhile(section, nl + 1)) > 0) {
        // After any blank/whitespace lines a new marker starts: stop before
        // consuming this newline.
        end = nl;
        break;
      }
      const nextNl = section.indexOf('\n', nl + 1);
      end = nextNl === -1 ? n : nextNl;
    }
    const cleaned = section.slice(start, end).replace(/\n\s+/g, ' ').trim();
    if (cleaned) {
      items.push(cleaned);
    }
    anchor = end;
  }
  return items;
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

  const items = extractLearningItems(match[1]);

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
  const key = source.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Collapse/trim dash runs without regex quantifiers — the chained
  // anchored quantifiers tripped CodeQL's polynomial-regex heuristic on
  // unbounded input even though each scan was linear.
  let trimmed = key;
  while (trimmed.startsWith('-')) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.endsWith('-')) {
    trimmed = trimmed.slice(0, -1);
  }
  let collapsed = '';
  let prevDash = false;
  for (const ch of trimmed) {
    if (ch === '-') {
      if (!prevDash) {
        collapsed += '-';
      }
      prevDash = true;
    } else {
      collapsed += ch;
      prevDash = false;
    }
  }
  return { topic_key: collapsed || 'untitled' };
}

module.exports = { save, capturePassive, suggestTopicKey };
