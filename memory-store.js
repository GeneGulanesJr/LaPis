#!/usr/bin/env node
/**
 * Memory-store.js — Pi Memory Layer CLI entry point
 *
 * Database operations via db.js. Code parsing via parse-code.js (WASM).
 * Code analysis via code-analysis.js. Doc indexing via doc-indexer.js.
 *
 * Usage: node memory-store.js <subcommand> [options]
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  DB_PATH, HOME,
  sqlJson, sqlRun, sqlRaw, ensureDb,
  getDb, getEngine,
  jsonOut, jsonErr, parseArgs,
} = require('./db');

const { getConfig } = require('./config');

// Lazily resolve db handle (available after ensureDb())
let db = null;



/* ── subcommands ───────────────────────────────────────────── */

// Tool tiering (v6) — control which commands appear in session-start context
const TOOL_TIERS = {
  core: new Set([
    'search', 'save', 'context', 'search-code', 'get-code-source',
    'importance', 'outline', 'winnow',
  ]),
  standard: new Set([
    'search', 'save', 'context', 'search-code', 'get-code-source',
    'importance', 'outline', 'winnow',
    'complexity', 'dead-code', 'hotspots', 'blast-radius',
    'call-hierarchy', 'cycles', 'coupling', 'churn', 'signal-chains',
  ]),
  full: null, // Null = all commands
};

function _readTierConfig() {
  const configPath = getConfig().tier_config_path;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    // Strip comments (//-style) for JSON parsing
    const cleaned = raw.replace(/\/\/.*$/gm, '');
    return JSON.parse(cleaned);
  } catch (_) {
    return { tier: 'full' };
  }
}

/* ── subcommands ───────────────────────────────────────────── */

function sessionStart(args) {
  const project = args.project;
  if (!project) {return jsonErr('Missing --project');}

  const sessionRows = sqlJson('INSERT INTO session_log (project) VALUES (?) RETURNING id, started_at', [project]);
  const sessionId = sessionRows[0].id;

  const countRows = sqlJson('SELECT COUNT(*) as cnt FROM session_log WHERE project = ?', [project]);
  const sessionCount = countRows[0].cnt;
  const compactInterval = getConfig().compact_every_n_sessions || 5;
  const consolidateDue = sessionCount > 0 && sessionCount % compactInterval === 0;

  const archiveCandidates = sqlJson(
    `
    SELECT project, MAX(started_at) as last_active
    FROM session_log
    WHERE project != ?
    GROUP BY project
    HAVING last_active < datetime('now', '-90 days')
  `,
    [project],
  );

  const incompleteSession = sqlJson(
    `
    SELECT id FROM session_log
    WHERE project = ? AND ended_at IS NULL AND id != ?
    ORDER BY started_at DESC LIMIT 1
  `,
    [project, sessionId],
  );

  // Auto-recover incomplete sessions
  let recoveredSession = null;
  if (incompleteSession.length > 0) {
    recoveredSession = autoRecoverInternal(String(incompleteSession[0].id));
  }

  const compacted = runCompact();

  // Tool tiering (v6)
  const tierConfig = _readTierConfig();
  const tier = tierConfig.tier || 'full';
  const tierSet = TOOL_TIERS[tier];
  const availableCommands = tierSet ? Object.keys(commands).filter(c => tierSet.has(c)) : Object.keys(commands);
  // Apply extra/hidden overrides
  const extra = tierConfig.extra_commands || [];
  const hidden = tierConfig.hidden_commands || [];
  const finalCommands = [...new Set([...availableCommands, ...extra])]
    .filter(c => !hidden.includes(c))
    .sort();

  return {
    sessionId,
    sessionCount,
    consolidateDue,
    compacted,
    archiveCandidates,
    recoveredSession,
    hasIncompletePreviousSession: incompleteSession.length > 0,
    incompleteSessionId: incompleteSession.length > 0 ? incompleteSession[0].id : null,
    tool_tier: tier,
    available_commands: finalCommands,
    available_commands_count: finalCommands.length,
  };
}

function sessionEnd(args) {
  const id = args.id;
  const memories = parseInt(args.memories || '0', 10);
  const auto = args.auto === 'true' || args.auto === true;
  if (!id) {return jsonErr('Missing --id');}

  let trustRecoveryResult = null;
  if (auto) {trustRecoveryResult = trustRecovery({ session: id });}

  sqlRun("UPDATE session_log SET ended_at = datetime('now'), memories_saved = ? WHERE id = ?", [
    memories,
    parseInt(id, 10),
  ]);
  const result = { ok: true, sessionId: parseInt(id, 10) };
  if (trustRecoveryResult) {result.trustRecovery = trustRecoveryResult;}
  return result;
}

/* ── observations ─────────────────────────────────────────── */

function save(args) {
  const title = args.title;
  const type = args.type || 'manual';
  const content = args.content;
  const project = args.project || null;
  const scope = args.scope || 'project';
  const topicKey = args['topic-key'] || null;
  const sessionId = args['session-id'] || findLatestSession(project);
  const force = args.force === 'true' || args.force === true;

  if (!title || !content) {return jsonErr('Missing --title and --content');}

  // Dedup check (skip if forced)
  if (!force) {
    const dupes = checkDuplicate(title, type, project, topicKey);
    if (dupes.potential_duplicates.length > 0) {
      const bestMatch = dupes.potential_duplicates[0];
      // Auto-merge at high confidence (≥85% trigram overlap)
      const dedupCfg = getConfig().dedup;
      if (bestMatch.similarity >= dedupCfg.auto_merge_threshold) {
        const keptId = bestMatch.id;
        const rows = sqlJson(
          `
          INSERT INTO observations (session_id, type, title, content, project, scope, topic_key)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          RETURNING id, created_at
        `,
          [String(sessionId), type, title, content, project, scope, topicKey],
        );
        const newId = rows[0].id;
        // Soft-delete the older duplicate, record the relation
        sqlRun(
          'INSERT OR IGNORE INTO observation_relations (source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?)',
          [newId, keptId, 'duplicate', bestMatch.similarity],
        );
        sqlRun("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", [keptId]);
        return {
          id: newId,
          title,
          created_at: rows[0].created_at,
          auto_merged: true,
          superseded_id: keptId,
          superseded_title: bestMatch.title,
          similarity: bestMatch.similarity,
        };
      }
      // Moderate confidence (60-84%): warn but let caller decide
      return {
        status: 'potential_duplicate',
        message: 'Similar observations exist. Use --force to save anyway.',
        matches: dupes.potential_duplicates.slice(0, 3),
        hint: 'node memory-store.js save --force ...',
      };
    }
  }

  const rows = sqlJson(
    `
    INSERT INTO observations (session_id, type, title, content, project, scope, topic_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id, created_at
  `,
    [String(sessionId), type, title, content, project, scope, topicKey],
  );
  return { id: rows[0].id, title, created_at: rows[0].created_at };
}

/* ── search ranking ─────────────────────────────────────── */

/**
 * Composite rank: FTS5 relevance, recency, trust, usefulness.
 * When FTS rank is 0 (LIKE fallback), estimates relevance via word overlap.
 */
function rankObservations(rows, query = '') {
  const now = Date.now();
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return rows
    .map((row) => {
      let ftsScore = 0;
      if (row.rank !== undefined && row.rank !== null && row.rank !== 0) {
        ftsScore = -row.rank;
      } else if (queryWords.length > 0) {
        // LIKE fallback: score by word overlap in title
        const title = (row.title || '').toLowerCase();
        const hits = queryWords.filter((w) => title.includes(w)).length;
        ftsScore = queryWords.length > 0 ? (hits / queryWords.length) * 2 : 0;
      }
      const ageMs = now - new Date(`${row.created_at  }Z`).getTime();
      const recencyScore = Math.exp(-ageMs / (7 * 24 * 60 * 60 * 1000));
      const trustScore = row.trust_score !== undefined && row.trust_score !== null ? row.trust_score : 0.7;
      const recallScore = Math.log(1 + (row.recall_count || 0)) * 0.2;
      const typeBoost =
        {
          decision: 1.3,
          architecture: 1.3,
          bugfix: 1.2,
          pattern: 1.2,
          preference: 1.2,
          config: 1.1,
          discovery: 1.0,
          learning: 1.0,
          session_summary: 0.7,
          skill: 0.5,
        }[row.type] || 1.0;
      const ranking = getConfig().ranking;
      const composite = (ftsScore * ranking.fts_relevance + recencyScore * ranking.recency + trustScore * ranking.trust + recallScore * ranking.recall) * typeBoost;
      return { ...row, _score: composite };
    })
    .sort((a, b) => b._score - a._score);
}

function search(args) {
  const query = args.query;
  const project = args.project || null;
  const type = args.type || null;
  const scope = args.scope || null;
  const limit = parseInt(args.limit || '10', 10);
  const sessionId = args['session-id'] ? parseInt(args['session-id'], 10) : null;
  const includeCode = args['include-code'] === 'true' || args['include-code'] === true;
  if (!query) {return jsonErr('Missing --query');}

  const isFtsSpecial = /[*"\-]|\b(AND|OR|NOT)\b/i.test(query);
  const needsFallback = query === '*' || query === '' || isFtsSpecial;

  let rows;
  if (!needsFallback) {
    try {
      let q = `
        SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
               snippet(observations_fts, 0, '»', '«', '…', 32) as snippet,
               rank,
               sl.trust_score,
               COALESCE(rl.recall_count, 0) as recall_count
        FROM observations o
        JOIN observations_fts fts ON o.id = fts.rowid
        LEFT JOIN (
          SELECT memory_id, MAX(trust_score) as trust_score
          FROM symbol_links GROUP BY memory_id
        ) sl ON sl.memory_id = CAST(o.id AS TEXT)
        LEFT JOIN (
          SELECT memory_id, COUNT(*) as recall_count
          FROM recall_log GROUP BY memory_id
        ) rl ON rl.memory_id = o.id
        WHERE observations_fts MATCH ?
          AND o.deleted_at IS NULL
      `;
      const params = [query];
      if (project) {
        q += ' AND o.project = ?';
        params.push(project);
      }
      if (type) {
        q += ' AND o.type = ?';
        params.push(type);
      }
      if (scope) {
        q += ' AND o.scope = ?';
        params.push(scope);
      }
      q += ' ORDER BY rank LIMIT ?';
      params.push(Math.min(limit * 3, 50));
      rows = sqlJson(q, params);
    } catch (e) {
      rows = null;
    }
  }

  if (!rows || rows.length === 0) {
    let q = `
      SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
             '' as snippet, 0 as rank,
             sl.trust_score,
             COALESCE(rl.recall_count, 0) as recall_count
      FROM observations o
      LEFT JOIN (
        SELECT memory_id, MAX(trust_score) as trust_score
        FROM symbol_links GROUP BY memory_id
      ) sl ON sl.memory_id = CAST(o.id AS TEXT)
      LEFT JOIN (
        SELECT memory_id, COUNT(*) as recall_count
        FROM recall_log GROUP BY memory_id
      ) rl ON rl.memory_id = o.id
      WHERE (o.title LIKE ? OR o.content LIKE ?)
        AND o.deleted_at IS NULL
    `;
    const like = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const params = [like, like];
    if (project) {
      q += ' AND o.project = ?';
      params.push(project);
    }
    if (type) {
      q += ' AND o.type = ?';
      params.push(type);
    }
    if (scope) {
      q += ' AND o.scope = ?';
      params.push(scope);
    }
    q += ' ORDER BY o.created_at DESC LIMIT ?';
    params.push(Math.min(limit * 3, 50));
    rows = sqlJson(q, params);
  }

  const ranked = rankObservations(rows, query).slice(0, limit);

  // Wire recall tracking: log every surfaced memory for ranking feedback
  if (sessionId && ranked.length > 0) {
    for (const r of ranked) {
      sqlRun('INSERT OR IGNORE INTO recall_log (memory_id, session_id, query) VALUES (?, ?, ?)', [
        r.id,
        sessionId,
        query,
      ]);
    }
  }

  // If --include-code, also search code symbols
  let codeResults = null;
  if (includeCode) {
    codeResults = searchCode(query, null, null, limit);
  }

  return { results: ranked, code_results: codeResults };
}

function context(args) {
  const project = args.project || null;
  const limit = parseInt(args.limit || '20', 10);
  const sessionId = args['session-id'] ? parseInt(args['session-id'], 10) : null;
  const topicKey = args['topic-key'] || null;
  const topicQuery = args.query || null;
  const deep = args.deep === 'true' || args.deep === true;
  const crossProject = !project || args['all-projects'] === 'true' || args['all-projects'] === true;
  if (!project && !crossProject) {return jsonErr('Missing --project');}

  // Active sessions
  const sessions = project
    ? sqlJson(
        `
    SELECT id, project, started_at, ended_at, memories_saved
    FROM session_log
    WHERE project = ?
    ORDER BY started_at DESC
    LIMIT 5
  `,
        [project],
      )
    : [];

  // Personal-scope observations (cross-project preferences)
  const personal = sqlJson(`
    SELECT id, title, type, scope, topic_key, created_at
    FROM observations
    WHERE scope = 'personal' AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  `);

  // Topic-aware, cross-project, or standard observations
  let obsQuery, obsParams;
  if (crossProject) {
    // Load from all known projects, grouped by project
    const crossLimit = deep ? limit * 2 : limit;
    obsQuery = `
      SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.project, o.created_at,
             COALESCE(sl.trust_score, 0.7) as trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             CASE o.type
               WHEN 'decision' THEN 3 WHEN 'architecture' THEN 3
               WHEN 'bugfix' THEN 2 WHEN 'pattern' THEN 2
               WHEN 'preference' THEN 2 WHEN 'config' THEN 1
               WHEN 'discovery' THEN 1 WHEN 'learning' THEN 1
               ELSE 0
             END as type_priority
      FROM observations o
      LEFT JOIN (
        SELECT memory_id, MAX(trust_score) as trust_score
        FROM symbol_links GROUP BY memory_id
      ) sl ON sl.memory_id = CAST(o.id AS TEXT)
      LEFT JOIN (
        SELECT memory_id, COUNT(*) as recall_count
        FROM recall_log GROUP BY memory_id
      ) rl ON rl.memory_id = o.id
      WHERE o.deleted_at IS NULL AND o.type != 'skill' AND o.scope = 'project'
      ORDER BY type_priority DESC, trust_score DESC, o.created_at DESC
      LIMIT ?
    `;
    obsParams = [crossLimit];
  } else if (topicKey || topicQuery) {
    // Load deeper context for a specific topic
    const topicLimit = deep ? Math.min(limit * 3, 100) : Math.min(limit * 2, 50);
    if (topicQuery) {
      // Search by content first, then union with topic_key matches
      obsQuery = `
        WITH topic_matches AS (
          SELECT id FROM observations
          WHERE project = ? AND deleted_at IS NULL AND type != 'skill'
            AND (topic_key LIKE ? OR title LIKE ? OR content LIKE ?)
          ORDER BY created_at DESC
          LIMIT ?
        )
        SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.created_at,
               COALESCE(sl.trust_score, 0.7) as trust_score,
               COALESCE(rl.recall_count, 0) as recall_count,
               CASE o.type
                 WHEN 'decision' THEN 3 WHEN 'architecture' THEN 3
                 WHEN 'bugfix' THEN 2 WHEN 'pattern' THEN 2
                 WHEN 'preference' THEN 2 WHEN 'config' THEN 1
                 WHEN 'discovery' THEN 1 WHEN 'learning' THEN 1
                 ELSE 0
               END as type_priority
        FROM observations o
        JOIN topic_matches tm ON o.id = tm.id
        LEFT JOIN (
          SELECT memory_id, MAX(trust_score) as trust_score
          FROM symbol_links GROUP BY memory_id
        ) sl ON sl.memory_id = CAST(o.id AS TEXT)
        LEFT JOIN (
          SELECT memory_id, COUNT(*) as recall_count
          FROM recall_log GROUP BY memory_id
        ) rl ON rl.memory_id = o.id
        ORDER BY type_priority DESC, trust_score DESC, o.created_at DESC
      `;
      const like = `%${topicQuery.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      obsParams = [project, like, like, like, topicLimit];
    } else {
      // Topic key filter — boost matches, still show other project memories
      obsQuery = `
        SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.created_at,
               COALESCE(sl.trust_score, 0.7) as trust_score,
               COALESCE(rl.recall_count, 0) as recall_count,
               CASE
                 WHEN o.topic_key = ? THEN 5
                 WHEN o.type = 'decision' THEN 3 WHEN o.type = 'architecture' THEN 3
                 WHEN o.type = 'bugfix' THEN 2 WHEN o.type = 'pattern' THEN 2
                 WHEN o.type = 'preference' THEN 2 WHEN o.type = 'config' THEN 1
                 WHEN o.type = 'discovery' THEN 1 WHEN o.type = 'learning' THEN 1
                 ELSE 0
               END as type_priority
        FROM observations o
        LEFT JOIN (
          SELECT memory_id, MAX(trust_score) as trust_score
          FROM symbol_links GROUP BY memory_id
        ) sl ON sl.memory_id = CAST(o.id AS TEXT)
        LEFT JOIN (
          SELECT memory_id, COUNT(*) as recall_count
          FROM recall_log GROUP BY memory_id
        ) rl ON rl.memory_id = o.id
        WHERE o.project = ? AND o.deleted_at IS NULL AND o.type != 'skill'
        ORDER BY type_priority DESC, trust_score DESC, o.created_at DESC
        LIMIT ?
      `;
      obsParams = [topicKey, project, topicLimit];
    }
  } else {
    // Standard priority-weighted project observations (excludes skills)
    obsQuery = `
      SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.created_at,
             COALESCE(sl.trust_score, 0.7) as trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             CASE o.type
               WHEN 'decision' THEN 3 WHEN 'architecture' THEN 3
               WHEN 'bugfix' THEN 2 WHEN 'pattern' THEN 2
               WHEN 'preference' THEN 2 WHEN 'config' THEN 1
               WHEN 'discovery' THEN 1 WHEN 'learning' THEN 1
               ELSE 0
             END as type_priority
      FROM observations o
      LEFT JOIN (
        SELECT memory_id, MAX(trust_score) as trust_score
        FROM symbol_links GROUP BY memory_id
      ) sl ON sl.memory_id = CAST(o.id AS TEXT)
      LEFT JOIN (
        SELECT memory_id, COUNT(*) as recall_count
        FROM recall_log GROUP BY memory_id
      ) rl ON rl.memory_id = o.id
      WHERE o.project = ? AND o.deleted_at IS NULL AND o.type != 'skill'
      ORDER BY type_priority DESC, trust_score DESC, o.created_at DESC
      LIMIT ?
    `;
    obsParams = [project, limit];
  }
  const observations = sqlJson(obsQuery, obsParams);

  // Active procedural workflows
  const workflows = project
    ? sqlJson(
        `
    SELECT id, name, status, success, updated_at
    FROM procedural_memory
    WHERE (project = ? OR project IS NULL) AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 5
  `,
        [project],
      )
    : [];

  // Wire recall tracking
  if (sessionId && observations.length > 0) {
    for (const o of observations) {
      sqlRun('INSERT OR IGNORE INTO recall_log (memory_id, session_id, query) VALUES (?, ?, ?)', [
        o.id,
        sessionId,
        topicQuery || topicKey || 'context-auto',
      ]);
    }
  }

  // Calculate stats: total across all projects vs current
  const totalAll = crossProject
    ? sqlJson('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL AND type != ?', ['skill'])[0].cnt
    : sqlJson('SELECT COUNT(*) as cnt FROM observations WHERE project = ? AND deleted_at IS NULL AND type != ?', [
        project,
        'skill',
      ])[0].cnt;

  return {
    sessions,
    personal,
    observations,
    workflows,
    project: project || null,
    cross_project: crossProject,
    topic: topicKey || topicQuery || null,
    stats: {
      total_memories: totalAll,
      total_personal: personal.length,
      active_workflows: workflows.length,
    },
  };
}

function get(args) {
  const id = args.id;
  if (!id) {return jsonErr('Missing --id');}
  const rows = sqlJson(
    `
    SELECT id, title, content, type, project, scope, topic_key,
           created_at, updated_at, deleted_at
    FROM observations
    WHERE id = ?
  `,
    [parseInt(id, 10)],
  );
  if (rows.length === 0) {return { error: 'Observation not found' };}

  const obs = rows[0];

  // Attach symbol links
  const links = sqlJson('SELECT symbol_id, repo, trust_score FROM symbol_links WHERE memory_id = ?', [String(id)]);
  if (links.length > 0) {obs.symbols = links;}

  // Attach recall count
  const recallCount = sqlJson('SELECT COUNT(*) as cnt FROM recall_log WHERE memory_id = ?', [parseInt(id, 10)]);
  obs.recall_count = recallCount[0].cnt;

  return obs;
}

function update(args) {
  const id = args.id;
  if (!id) {return jsonErr('Missing --id');}
  const sets = [];
  const params = [];
  if (args.title) {
    sets.push('title = ?');
    params.push(args.title);
  }
  if (args.content) {
    sets.push('content = ?');
    params.push(args.content);
  }
  if (args.type) {
    sets.push('type = ?');
    params.push(args.type);
  }
  if (args.project) {
    sets.push('project = ?');
    params.push(args.project);
  }
  if (args.scope) {
    sets.push('scope = ?');
    params.push(args.scope);
  }
  if (args['topic-key']) {
    sets.push('topic_key = ?');
    params.push(args['topic-key']);
  }
  if (sets.length === 0) {return jsonErr('Nothing to update');}

  params.push(parseInt(id, 10));
  sqlRun(`UPDATE observations SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, params);

  const rows = sqlJson(
    `
    SELECT id, title, content, type, project, scope, topic_key,
           created_at, updated_at
    FROM observations WHERE id = ?
  `,
    [parseInt(id, 10)],
  );
  return rows.length > 0 ? rows[0] : { error: 'Observation not found' };
}

function del(args) {
  const id = args.id;
  const hard = args.hard === 'true' || args.hard === true;
  if (!id) {return jsonErr('Missing --id');}

  if (hard) {
    sqlRun('DELETE FROM observations WHERE id = ?', [parseInt(id, 10)]);
    return { ok: true, hardDeleted: true };
  }
  sqlRun("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", [parseInt(id, 10)]);
  return { ok: true, hardDeleted: false };
}

function timeline(args) {
  const id = parseInt(args.id);
  const before = parseInt(args.before || '5', 10);
  const after = parseInt(args.after || '5', 10);
  if (isNaN(id)) {return jsonErr('Missing --id');}

  return sqlJson(
    `
    SELECT id, title, type, project, scope, created_at
    FROM observations
    WHERE id BETWEEN ? AND ?
      AND deleted_at IS NULL
    ORDER BY id
  `,
    [id - before, id + after],
  );
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

function savePrompt(args) {
  const content = args.content;
  const project = args.project || null;
  const sessionId = args['session-id'] || findLatestSession(project);
  if (!content) {return jsonErr('Missing --content');}

  const rows = sqlJson(
    `
    INSERT INTO user_prompts (session_id, content, project)
    VALUES (?, ?, ?)
    RETURNING id, created_at
  `,
    [String(sessionId), content, project],
  );
  return { id: rows[0].id, created_at: rows[0].created_at };
}

function capturePassive(args) {
  const content = args.content;
  if (!content) {return jsonErr('Missing --content');}

  const match = content.match(/##\s*Key\s*Learnings?:\s*([\s\S]*)/i);
  if (!match) {return { extracted: 0, items: [] };}

  const section = match[1];
  const itemRe = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*([^\n]*(?:\n(?!\s*(?:[-*]|\d+[.)])\s*)[^\n]*)*)/g;
  const items = [];
  let m;
  while ((m = itemRe.exec(section)) !== null) {
    const cleaned = m[1].replace(/\n\s+/g, ' ').trim();
    if (cleaned) {items.push(cleaned);}
  }

  let inserted = 0;
  const sessionId = findLatestSession(null);
  for (const item of items) {
    const summary = item.length > 80 ? `${item.slice(0, 77)  }…` : item;
    sqlJson('INSERT INTO observations (session_id, type, title, content, scope) VALUES (?, ?, ?, ?, ?)', [
      String(sessionId),
      'learning',
      summary,
      item,
      'project',
    ]);
    inserted++;
  }
  return { extracted: inserted, items };
}

function getStats() {
  const obs = sqlJson('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL')[0].cnt;
  const prompts = sqlJson('SELECT COUNT(*) as cnt FROM user_prompts')[0].cnt;
  const sessions = sqlJson('SELECT COUNT(*) as cnt FROM session_log')[0].cnt;
  const links = sqlJson('SELECT COUNT(*) as cnt FROM symbol_links')[0].cnt;
  const workflows = sqlJson('SELECT COUNT(*) as cnt FROM procedural_memory')[0].cnt;
  return {
    total_observations: obs,
    total_prompts: prompts,
    total_sessions: sessions,
    total_symbol_links: links,
    total_workflows: workflows,
  };
}

function sessionSummary(args) {
  const content = args.content;
  const project = args.project || null;
  const sessionId = args['session-id'] || findLatestSession(project);
  if (!content) {return jsonErr('Missing --content');}

  const rows = sqlJson(
    `
    INSERT INTO observations (session_id, type, title, content, project, scope)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id, created_at
  `,
    [String(sessionId), 'session_summary', 'Session Summary', content, project, 'project'],
  );
  return { id: rows[0].id, title: 'Session Summary', created_at: rows[0].created_at };
}

/* ── symbol anchoring ─────────────────────────────────────── */

function linkSymbol(args) {
  const memoryId = args.memory;
  const symbolId = args.symbol;
  const repo = args.repo;
  const trust = parseFloat(args.trust || (symbolId ? '1.0' : '0.7'));

  if (!memoryId || !repo) {return jsonErr('Missing --memory and --repo');}
  const symVal = symbolId || '__unlinked__';

  sqlRun('INSERT OR REPLACE INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)', [
    memoryId,
    symVal,
    repo,
    trust,
  ]);
  return { ok: true, memoryId, symbolId: symVal, repo, trustScore: trust };
}

function autoLink(args) {
  const project = args.project;
  if (!project) {return jsonErr('Missing --project');}

  const unlinked = sqlJson(
    `
    SELECT CAST(id AS TEXT) as memory_id FROM observations
    WHERE project = ? AND deleted_at IS NULL
      AND CAST(id AS TEXT) NOT IN (SELECT memory_id FROM symbol_links)
  `,
    [project],
  );

  let linked = 0;
  for (const row of unlinked) {
    sqlRun('INSERT OR IGNORE INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)', [
      String(row.memory_id),
      '__unlinked__',
      project,
      0.7,
    ]);
    linked++;
  }
  return { ok: true, project, linked, unlinkedCount: unlinked.length };
}

function adjustTrust(args) {
  const memoryId = args.memory;
  const reason = args.reason;
  const delta = parseFloat(args.delta);
  if (!memoryId || !reason || isNaN(delta)) {return jsonErr('Missing --memory, --reason, --delta');}

  sqlRun('UPDATE symbol_links SET trust_score = MAX(0.0, trust_score + ?) WHERE memory_id = ?', [delta, memoryId]);
  sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [memoryId, reason, delta]);

  const updated = sqlJson('SELECT trust_score FROM symbol_links WHERE memory_id = ? LIMIT 1', [memoryId]);
  return { ok: true, memoryId, newTrustScore: updated.length > 0 ? updated[0].trust_score : null };
}

function recordRecall(args) {
  const sessionId = parseInt(args.session);
  const memoryId = args.memory;
  if (!sessionId || !memoryId) {return jsonErr('Missing --session and --memory');}
  sqlRun('INSERT OR IGNORE INTO session_recalls (session_id, memory_id) VALUES (?, ?)', [sessionId, memoryId]);
  return { ok: true };
}

function staleLinks(args) {
  const project = args.project;
  if (!project) {return jsonErr('Missing --project');}
  return sqlJson(
    `SELECT memory_id, symbol_id, repo, trust_score, last_verified
     FROM symbol_links
     WHERE repo = ? AND symbol_id != '__unlinked__'
     ORDER BY trust_score ASC`,
    [project],
  );
}

/* ── project discovery ─────────────────────────────────────── */

function listProjects() {
  const rows = sqlJson(`
    SELECT project, COUNT(*) as memory_count,
           MAX(created_at) as last_active
    FROM observations
    WHERE deleted_at IS NULL AND type != 'skill'
    GROUP BY project
    ORDER BY last_active DESC
  `);
  return { projects: rows };
}

/* ── code-aware trust sync ─────────────────────────────────── */

/**
 * Sync trust scores against code changes.
 * Pipe changed symbols JSON as --changed-symbols-json.
 * For each linked symbol:
 *   - Changed → trust -= 0.3 (code drifted from memory)
 *   - Unchanged → trust += 0.05 (memory survived, proven durable)
 */
function syncCodeTrust(args) {
  const repo = args.repo;
  const changedJson = args['changed-symbols-json'] || args['changed-symbols'];
  if (!repo || !changedJson) {return jsonErr('Missing --repo and --changed-symbols-json');}

  let changedData;
  try {
    changedData = JSON.parse(changedJson);
  } catch (_) {
    return jsonErr('Invalid JSON for --changed-symbols-json');
  }

  // Normalise to a flat set of changed symbol IDs/names
  const changedSet = new Set();
  if (Array.isArray(changedData)) {
    for (const s of changedData) {
      if (typeof s === 'string') {changedSet.add(s);}
      else if (s && s.symbol_id) {changedSet.add(s.symbol_id);}
      else if (s && s.name) {changedSet.add(s.name);}
    }
  } else if (changedData && typeof changedData === 'object') {
    for (const key of ['added', 'modified', 'removed', 'changed']) {
      const arr = changedData[key];
      if (!Array.isArray(arr)) {continue;}
      for (const s of arr) {
        if (typeof s === 'string') {changedSet.add(s);}
        else if (s && s.symbol_id) {changedSet.add(s.symbol_id);}
        else if (s && s.name) {changedSet.add(s.name);}
      }
    }
  }
  if (changedSet.size === 0) {return jsonErr('No changed symbols found in input');}

  // Get all anchored links for this repo
  const allLinks = sqlJson(
    `SELECT memory_id, symbol_id, trust_score, last_verified
     FROM symbol_links WHERE repo = ? AND symbol_id != '__unlinked__'`,
    [repo],
  );

  const result = { total: allLinks.length, adjusted: [], survived: [], unchanged: [] };

  for (const link of allLinks) {
    const isChanged = [...changedSet].some(
      (cs) => link.symbol_id === cs || link.symbol_id.endsWith(`::${  cs}`) || link.symbol_id.includes(cs),
    );

    if (isChanged) {
      const delta = -0.3;
      const newTrust = Math.max(0.0, link.trust_score + delta);
      sqlRun(
        "UPDATE symbol_links SET trust_score = ?, last_verified = datetime('now') WHERE memory_id = ? AND symbol_id = ?",
        [newTrust, link.memory_id, link.symbol_id],
      );
      sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [
        link.memory_id,
        'symbol_changed',
        delta,
      ]);
      result.adjusted.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
    } else if (link.trust_score < 0.95) {
      const delta = 0.05;
      const newTrust = Math.min(1.0, link.trust_score + delta);
      sqlRun(
        "UPDATE symbol_links SET trust_score = ?, last_verified = datetime('now') WHERE memory_id = ? AND symbol_id = ?",
        [newTrust, link.memory_id, link.symbol_id],
      );
      sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [
        link.memory_id,
        'survived_unchanged',
        delta,
      ]);
      result.survived.push({
        memory_id: link.memory_id,
        symbol_id: link.symbol_id,
        old_trust: link.trust_score,
        new_trust: newTrust,
      });
    } else {
      result.unchanged.push({ memory_id: link.memory_id, symbol_id: link.symbol_id });
    }
  }

  return result;
}

/* ── symbol-aware recall ─────────────────────────────────── */

function symbolCluster(args) {
  const symbolId = args.symbol;
  const repo = args.repo || null;
  if (!symbolId) {return jsonErr('Missing --symbol');}

  let q = `
    SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
           sl.trust_score
    FROM observations o
    JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
    WHERE sl.symbol_id = ?
      AND o.deleted_at IS NULL
  `;
  const params = [symbolId];
  if (repo) {
    q += ' AND sl.repo = ?';
    params.push(repo);
  }
  q += ' ORDER BY o.created_at DESC';

  return { symbol: symbolId, memories: sqlJson(q, params) };
}

function related(args) {
  const id = parseInt(args.id);
  if (isNaN(id)) {return jsonErr('Missing --id');}

  const symbols = sqlJson('SELECT symbol_id, repo FROM symbol_links WHERE memory_id = ? AND symbol_id != ?', [
    String(id),
    '__unlinked__',
  ]);
  if (symbols.length === 0) {return { memory_id: id, related: [] };}

  const result = [];
  for (const sym of symbols) {
    const cluster = sqlJson(
      `
      SELECT o.id, o.title, o.type, o.project, o.created_at
      FROM observations o
      JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
      WHERE sl.symbol_id = ?
        AND o.id != ?
        AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC LIMIT 5
    `,
      [sym.symbol_id, id],
    );
    if (cluster.length > 0) {
      result.push({ symbol: sym.symbol_id, repo: sym.repo, memories: cluster });
    }
  }

  return { memory_id: id, related: result };
}

/* ── deduplication ───────────────────────────────────────── */

function trigramOverlap(a, b) {
  const trigrams = (s) => {
    const t = new Set();
    const lower = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let i = 0; i <= lower.length - 3; i++) {t.add(lower.slice(i, i + 3));}
    return t;
  };
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) {return 1.0;}
  if (ta.size === 0 || tb.size === 0) {return 0.0;}
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) {shared++;}
  }
  return shared / Math.max(ta.size, tb.size);
}

function checkDuplicate(title, type, project, topicKey) {
  let q = `
    SELECT id, title, topic_key, created_at
    FROM observations
    WHERE type = ? AND deleted_at IS NULL
  `;
  const params = [type];
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
  q += ' LIMIT 20';
  const candidates = sqlJson(q, params);

  const duplicates = [];
  const warningThreshold = getConfig().dedup.warning_threshold;
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

function markDuplicate(args) {
  const source = parseInt(args.source);
  const target = parseInt(args.target);
  const confidence = parseFloat(args.confidence || '0.9');
  if (!source || !target) {return jsonErr('Missing --source and --target');}

  sqlRun(
    'INSERT OR REPLACE INTO observation_relations (source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?)',
    [source, target, 'duplicate', confidence],
  );
  sqlRun("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", [target]);
  return { ok: true, merged: { kept: source, removed: target } };
}

/* ── auto session recovery ──────────────────────────────── */

function autoRecoverInternal(sessionId) {
  const session = sqlJson('SELECT * FROM session_log WHERE id = ?', [parseInt(sessionId)]);
  if (session.length === 0) {return null;}

  const obs = sqlJson(
    `
    SELECT id, title, type, content, created_at
    FROM observations
    WHERE session_id = ? AND deleted_at IS NULL AND type NOT IN ('skill', 'session_summary', 'progress', 'accomplished')
    ORDER BY created_at ASC
  `,
    [sessionId],
  );

  // If no valuable observations, just close the session silently
  // (skip noise types: skill, session_summary, progress, accomplished)
  if (obs.length === 0) {
    sqlRun("UPDATE session_log SET ended_at = datetime('now') WHERE id = ?", [parseInt(sessionId)]);
    return null;
  }

  const types = {};
  for (const o of obs) {
    if (!types[o.type]) {types[o.type] = [];}
    types[o.type].push(o.title);
  }

  const lines = ['## Auto-Recovered Session Summary', ''];
  lines.push(`**Session:** ${  sessionId}`);
  lines.push(`**Started:** ${  session[0].started_at}`);
  lines.push(`**Observations:** ${  obs.length}`);
  lines.push('');
  for (const [type, titles] of Object.entries(types)) {
    lines.push(`### ${  type}`);
    for (const t of titles) {lines.push('- ' + t);}
    lines.push('');
  }
  const summary = lines.join('\n');

  sqlJson(
    `
    INSERT INTO observations (session_id, type, title, content, project, scope)
    VALUES (?, 'session_summary', 'Auto-Recovered Session Summary', ?, ?, 'project')
    RETURNING id
  `,
    [sessionId, summary, session[0].project],
  );

  sqlRun("UPDATE session_log SET ended_at = datetime('now') WHERE id = ?", [parseInt(sessionId)]);

  return {
    status: 'recovered',
    observations_processed: obs.length,
    types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, v.length])),
  };
}

function autoRecover(args) {
  const sessionId = args.session;
  if (!sessionId) {return jsonErr('Missing --session');}
  const result = autoRecoverInternal(sessionId);
  if (!result) {return { status: 'nothing_to_recover' };}
  return result;
}

function recoverOrphans() {
  const orphans = sqlJson('SELECT id, project FROM session_log WHERE ended_at IS NULL ORDER BY started_at DESC');
  if (orphans.length === 0) {return { recovered: [], total: 0 };}

  const recovered = [];
  const allObservations = [];
  for (const o of orphans) {
    const r = autoRecoverInternal(String(o.id));
    if (r) {
      recovered.push(o.project);
      allObservations.push(r.observations_processed);
    }
  }

  // If multiple orphans were recovered, consolidate into a single summary
  // instead of leaving N individual session_summary observations
  if (recovered.length > 1) {
    // Collect all auto-recovered session_summary observations created just now
    const recentSummaries = sqlJson(
      `SELECT id, content FROM observations
       WHERE type = 'session_summary'
       AND title = 'Auto-Recovered Session Summary'
       AND created_at > datetime('now', '-5 minutes')
       AND deleted_at IS NULL
       ORDER BY id ASC`,
    );

    if (recentSummaries.length > 1) {
      // Build a single consolidated summary
      const lines = ['## Consolidated Recovery Summary', ''];
      lines.push(`**Sessions recovered:** ${recentSummaries.length}`);
      lines.push(`**Total observations:** ${allObservations.reduce((a, b) => a + b, 0)}`);
      lines.push('');

      const projects = [...new Set(recovered)];
      lines.push(`**Projects:** ${projects.join(', ')}`);
      lines.push('');

      // Soft-delete the individual summaries
      for (const s of recentSummaries) {
        sqlRun('UPDATE observations SET deleted_at = datetime(\'now\') WHERE id = ?', [s.id]);
      }

      // Insert the consolidated summary
      const consolidatedContent = lines.join('\n');
      sqlJson(
        `INSERT INTO observations (session_id, type, title, content, project, scope)
         VALUES (?, 'session_summary', 'Consolidated Recovery Summary', ?, ?, 'project')
         RETURNING id`,
        [recentSummaries[0].id, consolidatedContent, orphans[0].project],
      );
    }
  }

  return { recovered, total: orphans.length };
}

/* ── procedural memory ────────────────────────────────────── */

function saveWorkflow(args) {
  const id = args.id;
  const name = args.name;
  const project = args.project || null;
  const stepsRaw = args.steps || null;
  if (!id || !name) {return jsonErr('Missing --id and --name');}

  sqlRun('INSERT OR IGNORE INTO procedural_memory (id, name, project) VALUES (?, ?, ?)', [id, name, project]);

  if (stepsRaw) {
    const steps = stepsRaw
      .split(/\\n|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let stepNum = 1;
    for (const cmd of steps) {
      sqlRun(
        'INSERT OR REPLACE INTO procedural_steps (workflow, step_num, command, success, attempts) VALUES (?, ?, ?, 1.0, 1)',
        [id, stepNum, cmd],
      );
      stepNum++;
    }
  }
  return { ok: true, stepsSaved: stepsRaw ? stepsRaw.split(/\\n|\n/).filter(Boolean).length : 0 };
}

function recordStep(args) {
  const workflow = args.workflow;
  const step = parseInt(args.step);
  const command = args.command;
  if (!workflow || isNaN(step) || !command) {return jsonErr('Missing --workflow, --step, --command');}
  sqlRun(
    'INSERT OR REPLACE INTO procedural_steps (workflow, step_num, command, success, attempts) VALUES (?, ?, ?, 1.0, 1)',
    [workflow, step, command],
  );
  return { ok: true };
}

function stepOutcome(args) {
  const workflow = args.workflow;
  const step = parseInt(args.step);
  const success = args.success === 'true';
  const workaround = args.workaround || null;
  if (!workflow || isNaN(step)) {return jsonErr('Missing --workflow and --step');}

  if (success) {
    sqlRun(
      'UPDATE procedural_steps SET success = MIN(1.0, success + 0.1), attempts = attempts + 1 WHERE workflow = ? AND step_num = ?',
      [workflow, step],
    );
  } else {
    sqlRun(
      'UPDATE procedural_steps SET success = MAX(0.0, success - 0.2), attempts = attempts + 1, fail_workaround = ? WHERE workflow = ? AND step_num = ?',
      [workaround || null, workflow, step],
    );
  }
  const updated = sqlJson(
    'SELECT success, attempts, fail_workaround FROM procedural_steps WHERE workflow = ? AND step_num = ?',
    [workflow, step],
  );
  return updated.length > 0 ? { ok: true, ...updated[0] } : { ok: true };
}

function getWorkflow(args) {
  const id = args.id;
  if (!id) {return jsonErr('Missing --id');}
  const meta = sqlJson('SELECT * FROM procedural_memory WHERE id = ? LIMIT 1', [id]);
  if (meta.length === 0) {return { error: 'Workflow not found' };}
  const steps = sqlJson('SELECT * FROM procedural_steps WHERE workflow = ? ORDER BY step_num', [id]);
  return { ...meta[0], steps };
}

/* ── compaction ────────────────────────────────────────────── */

function runCompact() {
  const startedAt = new Date().toISOString();
  const report = { startedAt, steps: {} };

  try {
    sqlRun(
      'DELETE FROM symbol_links WHERE memory_id NOT IN (SELECT CAST(id AS TEXT) FROM observations WHERE deleted_at IS NULL)',
    );
    report.steps.deadLinksCleaned = true;

    sqlRun("DELETE FROM observations WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')");
    report.steps.purgedSoftDeleted = true;

    sqlRun(`DELETE FROM observations WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) AS rn
        FROM observations WHERE type = 'session_summary' AND deleted_at IS NULL
      ) WHERE rn > 3
    )`);
    report.steps.oldSummariesPruned = true;

    sqlRun(`DELETE FROM user_prompts WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) AS rn
        FROM user_prompts
      ) WHERE rn > 10
    )`);
    report.steps.oldPromptsPruned = true;

    sqlRun(`DELETE FROM session_log WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY started_at DESC) AS rn
        FROM session_log
      ) WHERE rn <= 5
    )`);
    report.steps.sessionLogPruned = true;

    sqlRun("DELETE FROM trust_adjustments WHERE timestamp < datetime('now', '-90 days')");
    report.steps.trustAdjustmentsPruned = true;

    sqlRun('DELETE FROM session_recalls WHERE session_id NOT IN (SELECT id FROM session_log)');
    report.steps.recallsPruned = true;

    sqlRun("DELETE FROM procedural_memory WHERE updated_at < datetime('now', '-90 days')");
    report.steps.oldWorkflowsPruned = true;

    sqlRun(`UPDATE symbol_links SET trust_score = MAX(0.0, trust_score - 0.05)
      WHERE memory_id IN (
        SELECT CAST(id AS TEXT) FROM observations WHERE updated_at < datetime('now', '-90 days')
      ) AND trust_score > 0.0`);
    report.steps.staleTrustDecayed = true;

    sqlRaw('VACUUM;');
    report.steps.vacuumed = true;

    sqlRaw("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
    sqlRaw("INSERT INTO prompts_fts(prompts_fts) VALUES('optimize')");
    report.steps.ftsOptimized = true;

    report.completedAt = new Date().toISOString();
    report.ok = true;
  } catch (e) {
    report.error = e.message;
    report.ok = false;
  }
  return report;
}

function compact() {
  return runCompact();
}

/* ── init ─────────────────────────────────────────────────── */
function initDb() {
  // EnsureDb() is called from the main dispatch block, so the DB is already initialized
  ensureDb();
  return { ok: true, db: DB_PATH, engine: getEngine() };
}

function trustRecovery(args) {
  const sessionId = parseInt(args.session);
  if (!sessionId) {return jsonErr('Missing --session');}

  const recalled = sqlJson('SELECT memory_id FROM session_recalls WHERE session_id = ?', [sessionId]);
  let recovered = 0;
  for (const row of recalled) {
    sqlRun('UPDATE symbol_links SET trust_score = MIN(1.0, trust_score + 0.1) WHERE memory_id = ?', [
      String(row.memory_id),
    ]);
    sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [
      String(row.memory_id),
      'passive_survival',
      0.1,
    ]);
    recovered++;
  }
  return { ok: true, memoriesRecovered: recovered };
}

/* ── helpers ──────────────────────────────────────────────── */
function findLatestSession(project) {
  const q = project
    ? 'SELECT id FROM session_log WHERE project = ? ORDER BY started_at DESC LIMIT 1'
    : 'SELECT id FROM session_log ORDER BY started_at DESC LIMIT 1';
  const rows = sqlJson(q, project ? [project] : []);
  return rows.length > 0 ? String(rows[0].id) : 'legacy';
}

/* ═══════════════════════════════════════════════════════════
   CODE INDEXING (v3 — tree-sitter AST via WASM, in-process)
   ═══════════════════════════════════════════════════════════ */

const codeParser = require('./parse-code');
const codeAnalysis = require('./code-analysis');
const gitAnalysis = require('./git-analysis');
const docIndexer = require('./doc-indexer');
const responseMeta = require('./response-meta');
const wireFormat = require('./wire-format');
const astPatterns = require('./ast-patterns');

// Internal DB fields that are meaningless to the LLM consumer — stripped from compact output
const _STRIP_FIELDS = ['symbol_id', 'id'];

function parseCodeFile(filePath) {
  return codeParser.parseFile(filePath);
}

async function ensureParserAvailable() {
  if (codeParser.isReady()) {return true;}
  await codeParser.init();
  return codeParser.isReady();
}

const _IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'coverage', '.next', '.nuxt']);
const _CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.go', '.rs', '.py', '.pyw']);

function isCodeFile(filePath) {
  return _CODE_EXTS.has(path.extname(filePath).toLowerCase());
}

function walkDir(dirPath) {
  const results = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {continue;}
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!_IGNORE_DIRS.has(entry.name)) {walk(fullPath);}
        } else if (entry.isFile() && isCodeFile(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch (_) {}
  }
  walk(dirPath);
  return results;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function indexRepoInternal(repoPath, repoName) {
  if (!(await ensureParserAvailable())) {
    return { error: `WASM tree-sitter parser not available. Run: cd ${  __dirname  } && npm install web-tree-sitter` };
  }

  const absPath = path.resolve(repoPath);
  if (!fs.existsSync(absPath)) {return { error: `Path not found: ${absPath}` };}

  const files = walkDir(absPath);
  let symbolCount = 0;
  let fileCount = 0;
  const skipped = [];

  // Upsert repo
  const existing = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repoName]);
  let repoId;
  if (existing.length > 0) {
    repoId = existing[0].id;
    sqlRun('DELETE FROM code_symbols WHERE repo_id = ?', [repoId]);
    sqlRun('DELETE FROM code_files WHERE repo_id = ?', [repoId]);
  } else {
    sqlRun('INSERT INTO code_repos (name, path) VALUES (?, ?)', [repoName, absPath]);
    repoId = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repoName])[0].id;
  }

  // Capture current HEAD commit for freshness checks
  let headCommit = null;
  try {
    headCommit = require('child_process').execSync('git rev-parse HEAD', {
      cwd: absPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch (_) { /* Non-git repo or git error */ }

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const contentHash = hashContent(content);
      const lines = content.split('\n');
      const stats = fs.statSync(filePath);

      sqlRun(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash, mtime, size_bytes, line_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          repoId,
          filePath,
          path.extname(filePath).slice(1),
          content,
          contentHash,
          stats.mtimeMs,
          stats.size,
          lines.length,
        ],
      );
      const fileRow = sqlJson('SELECT id FROM code_files WHERE repo_id = ? AND path = ?', [repoId, filePath]);
      const fileId = fileRow[0].id;

      const symbols = parseCodeFile(filePath);
      for (const sym of symbols) {
        sqlRun(
          `INSERT INTO code_symbols (repo_id, file_id, file_path, name, kind, signature, qualified_name,
           start_line, end_line, start_byte, end_byte, docstring, body_preview, language, parent_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            repoId,
            fileId,
            filePath,
            sym.name,
            sym.kind,
            sym.signature,
            sym.qualified_name,
            sym.start_line,
            sym.end_line,
            sym.start_byte,
            sym.end_byte,
            sym.docstring || '',
            sym.body_preview || '',
            sym.language,
            sym.parent_name || '',
          ],
        );
        symbolCount++;
      }
      fileCount++;
    } catch (e) {
      skipped.push({ file: filePath, error: e.message });
    }
  }

  sqlRun("UPDATE code_repos SET file_count = ?, symbol_count = ?, head_commit = ?, updated_at = datetime('now') WHERE id = ?", [
    fileCount,
    symbolCount,
    headCommit || null,
    repoId,
  ]);

  // Build import graph, call graph, and complexity
  let importEdges = 0,
    callEdges = 0,
    complexityCount = 0;
  try {
    const ig = codeAnalysis.buildImportGraph(db, repoId);
    if (ig.success) {importEdges = ig.edges;}
  } catch (_) {}
  try {
    const cg = codeAnalysis.buildCallGraph(db, repoId);
    if (cg.success) {callEdges = cg.calls;}
  } catch (_) {}
  try {
    const cc = codeAnalysis.buildComplexity(db, repoId);
    if (cc.success) {complexityCount = cc.symbols;}
  } catch (_) {}

  return {
    success: true,
    repo: repoName,
    path: absPath,
    files_indexed: fileCount,
    symbols_extracted: symbolCount,
    files_skipped: skipped.length,
    import_edges: importEdges,
    call_edges: callEdges,
    complexity_symbols: complexityCount,
    skipped,
  };
}

async function reindexRepoInternal(repo, mode) {
  const existing = sqlJson('SELECT id, path FROM code_repos WHERE name = ?', [repo]);
  if (existing.length === 0) {return { error: `Repo not found: ${repo}` };}
  const { id: repoId, path: repoPath } = existing[0];

  if (mode === 'full') {
    sqlRun('DELETE FROM code_symbols WHERE repo_id = ?', [repoId]);
    sqlRun('DELETE FROM code_files WHERE repo_id = ?', [repoId]);
    return indexRepoInternal(repoPath, repo);
  }

  // Incremental: only re-index files whose mtime changed
  if (!(await ensureParserAvailable())) {return { error: 'WASM tree-sitter parser not available' };}

  const files = walkDir(repoPath);
  let reindexed = 0;
  let unchanged = 0;
  let symbolCount = 0;

  const existingFiles = {};
  const efRows = sqlJson('SELECT path, mtime, id FROM code_files WHERE repo_id = ?', [repoId]);
  for (const row of efRows) {existingFiles[row.path] = { mtime: row.mtime, id: row.id };}

  for (const filePath of files) {
    try {
      const stats = fs.statSync(filePath);
      const prev = existingFiles[filePath];

      if (prev && prev.mtime === stats.mtimeMs) {
        unchanged++;
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const contentHash = hashContent(content);
      const lines = content.split('\n');
      let fileId;

      if (prev) {
        sqlRun('DELETE FROM code_symbols WHERE file_id = ?', [prev.id]);
        sqlRun(
          'UPDATE code_files SET content = ?, content_hash = ?, mtime = ?, size_bytes = ?, line_count = ? WHERE id = ?',
          [content, contentHash, stats.mtimeMs, stats.size, lines.length, prev.id],
        );
        fileId = prev.id;
      } else {
        sqlRun(
          'INSERT INTO code_files (repo_id, path, language, content, content_hash, mtime, size_bytes, line_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            repoId,
            filePath,
            path.extname(filePath).slice(1),
            content,
            contentHash,
            stats.mtimeMs,
            stats.size,
            lines.length,
          ],
        );
        fileId = sqlJson('SELECT id FROM code_files WHERE repo_id = ? AND path = ?', [repoId, filePath])[0].id;
      }

      const symbols = parseCodeFile(filePath);
      for (const sym of symbols) {
        sqlRun(
          `INSERT INTO code_symbols (repo_id, file_id, file_path, name, kind, signature, qualified_name,
           start_line, end_line, start_byte, end_byte, docstring, body_preview, language, parent_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            repoId,
            fileId,
            filePath,
            sym.name,
            sym.kind,
            sym.signature,
            sym.qualified_name,
            sym.start_line,
            sym.end_line,
            sym.start_byte,
            sym.end_byte,
            sym.docstring || '',
            sym.body_preview || '',
            sym.language,
            sym.parent_name || '',
          ],
        );
        symbolCount++;
      }
      reindexed++;
    } catch (_) {}
  }

  sqlRun(
    "UPDATE code_repos SET file_count = (SELECT count(*) FROM code_files WHERE repo_id = ?), symbol_count = ?, updated_at = datetime('now') WHERE id = ?",
    [repoId, symbolCount, repoId],
  );

  // Build import graph, call graph, and complexity
  let importEdges = 0,
    callEdges = 0,
    complexityCount = 0;
  try {
    const ig = codeAnalysis.buildImportGraph(db, repoId);
    if (ig.success) {importEdges = ig.edges;}
  } catch (_) {}
  try {
    const cg = codeAnalysis.buildCallGraph(db, repoId);
    if (cg.success) {callEdges = cg.calls;}
  } catch (_) {}
  try {
    const cc = codeAnalysis.buildComplexity(db, repoId);
    if (cc.success) {complexityCount = cc.symbols;}
  } catch (_) {}
  return {
    success: true,
    repo,
    mode,
    files_reindexed: reindexed,
    files_unchanged: unchanged,
    symbols_extracted: symbolCount,
    import_edges: importEdges,
    call_edges: callEdges,
    complexity_symbols: complexityCount,
  };
}

/** Fallback search using LIKE when FTS5 is unavailable */
function searchCodeLike(query, repoName, kind, maxResults) {
  const likeQuery = `%${  query.replace(/%/g, '\\%').replace(/_/g, '\\_')  }%`;
  let sql = `
    SELECT
      s.id, r.name AS repo, s.file_path AS file,
      s.name AS symbol_name, s.kind, s.start_line, s.end_line,
      s.signature, s.docstring, s.body_preview AS snippet,
      s.qualified_name, s.language,
      0.0 AS score
    FROM code_symbols s
    JOIN code_repos r ON r.id = s.repo_id
    WHERE s.name LIKE ?
  `;
  const params = [likeQuery];

  if (repoName) {
    sql += ' AND r.name = ?';
    params.push(repoName);
  }
  if (kind) {
    sql += ' AND s.kind = ?';
    params.push(kind);
  }

  sql += ' LIMIT ?';
  params.push(maxResults);

  const rows = sqlJson(sql, params);
  return { results: rows.map((row, i) => ({
    rank: i + 1,
    score: row.score,
    repo: row.repo,
    file: row.file,
    symbol: row.symbol_name,
    kind: row.kind,
    line: row.start_line,
    end_line: row.end_line,
    signature: row.signature,
    docstring: row.docstring,
    snippet: row.snippet,
    qualified_name: row.qualified_name,
    language: row.language,
  })) };
}

function searchCode(query, repoName, kind, maxResults) {
  ensureDb();

  // Ensure FTS table exists (may fail silently on some SQLite builds)
  try {
    const ftsCheck = sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='code_symbols_fts'");
    if (!ftsCheck.length) {
      // Try to create the FTS virtual table
      try {
        sqlRaw(`CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
          name, kind, signature, docstring, file_path, body_preview, content=code_symbols, content_rowid=id)`);
      } catch (_) {
        // FTS5 not available — fall back to LIKE-based search
        return searchCodeLike(query, repoName, kind, maxResults);
      }
    }
  } catch (_) {
    return searchCodeLike(query, repoName, kind, maxResults);
  }

  const ftsQuery = query.replace(/"/g, "''").split(/\s+/).join(' OR ');

  let sql = `
    SELECT
      s.id, r.name AS repo, s.file_path AS file,
      s.name AS symbol_name, s.kind, s.start_line, s.end_line,
      s.signature, s.docstring, s.body_preview AS snippet,
      s.qualified_name, s.language,
      bm25(code_symbols_fts) AS score
    FROM code_symbols_fts
    JOIN code_symbols s ON s.id = code_symbols_fts.rowid
    JOIN code_repos r ON r.id = s.repo_id
    WHERE code_symbols_fts MATCH ?
  `;
  const params = [ftsQuery];

  if (repoName) {
    sql += ' AND r.name = ?';
    params.push(repoName);
  }
  if (kind) {
    sql += ' AND s.kind = ?';
    params.push(kind);
  }

  sql += ' ORDER BY bm25(code_symbols_fts) LIMIT ?';
  params.push(maxResults);

  const rows = sqlJson(sql, params);
  const results = rows.map((row, i) => ({
    rank: i + 1,
    score: row.score,
    repo: row.repo,
    file: row.file,
    symbol: row.symbol_name,
    kind: row.kind,
    line: row.start_line,
    end_line: row.end_line,
    signature: row.signature,
    docstring: row.docstring,
    snippet: row.snippet,
    language: row.language,
  }));

  return { query, results, total: results.length };
}

function getCodeSource(repoName, filePath, symbolName) {
  ensureDb();
  const rows = sqlJson(
    `SELECT s.*, f.content
     FROM code_symbols s
     JOIN code_files f ON f.id = s.file_id
     JOIN code_repos r ON r.id = s.repo_id
     WHERE r.name = ? AND s.file_path = ? AND s.name = ?`,
    [repoName, filePath, symbolName],
  );
  if (rows.length === 0) {return { success: false, error: 'Symbol not found' };}

  const row = rows[0];
  // Use Buffer for byte-accurate slicing (Python reports byte offsets,
  // But JS string operations use UTF-16 code units which differ for
  // Multi-byte Unicode characters like box-drawing ──)
  const buf = Buffer.from(row.content, 'utf-8');
  const source = buf.toString('utf-8', row.start_byte, row.end_byte);
  return {
    success: true,
    repo: repoName,
    file: filePath,
    symbol: row.name,
    kind: row.kind,
    start_line: row.start_line,
    end_line: row.end_line,
    source,
  };
}

function listCodeReposInternal() {
  ensureDb();
  const repos = sqlJson(
    'SELECT name, path, file_count, symbol_count, indexed_at, updated_at FROM code_repos ORDER BY updated_at DESC',
  );
  return { repos, total: repos.length };
}

function removeCodeRepoInternal(repo) {
  ensureDb();
  const existing = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
  if (existing.length === 0) {return { error: `Repo not found: ${repo}` };}
  sqlRun('DELETE FROM code_repos WHERE id = ?', [existing[0].id]);
  return { success: true, repo, removed: true };
}

/* ── workspace management (v4) ────────────────────────────── */

function listWorkspaces() {
  ensureDb();
  const workspaces = sqlJson(`
    SELECT w.id, w.name, w.created_at, w.archived_at,
           COUNT(CASE WHEN o.deleted_at IS NULL AND o.type != 'skill' THEN 1 END) as memory_count,
           MAX(o.created_at) as last_active
    FROM workspaces w
    LEFT JOIN observations o ON o.project = w.name
    GROUP BY w.id
    ORDER BY w.archived_at NULLS FIRST, last_active DESC
  `);
  return { workspaces, total: workspaces.length };
}

function createWorkspace(name) {
  if (!name) {return { error: 'Missing --name' };}
  ensureDb();
  try {
    sqlRun('INSERT INTO workspaces (name) VALUES (?)', [name]);
    const row = sqlJson('SELECT id, name, created_at FROM workspaces WHERE name = ?', [name]);
    return { success: true, workspace: row[0] };
  } catch (e) {
    return { error: `Workspace already exists: ${name}` };
  }
}

function archiveWorkspace(name) {
  if (!name) {return { error: 'Missing --name' };}
  ensureDb();
  const existing = sqlJson('SELECT id FROM workspaces WHERE name = ? AND archived_at IS NULL', [name]);
  if (existing.length === 0) {return { error: `Workspace not found or already archived: ${name}` };}
  sqlRun("UPDATE workspaces SET archived_at = datetime('now') WHERE id = ?", [existing[0].id]);
  return { success: true, workspace: name, archived: true };
}

/* ── dispatch helpers ─────────────────────────────────────── */

/**
 * _dispatch(repoName, fn) — DRY repo lookup for analysis subcommands.
 * Resolves repo name → repoRow (with id, path, head_commit), calls fn(repoRow).
 * Returns fn's result or throws via jsonErr if repo not found.
 */
function _dispatch(repoName, fn) {
  if (!repoName) {jsonErr('Missing --repo');}
  const repoRow = sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
  if (!repoRow.length) {jsonErr(`Repo "${repoName}" not found. Run index-repo first.`);}
  return fn(repoRow[0]);
}

/**
 * _wrapAnalysis(toolName, data, repoRow, startTime) — wrap analysis result
 * with _meta envelope and optional format conversion.
 */
function _wrapAnalysis(toolName, data, repoRow, startTime, format) {
  // Map CLI subcommand names to internal tool names for confidence/computed
  const toolMap = {
    'import-graph': 'getImportGraph',
    'call-hierarchy': 'getCallHierarchy',
    'blast-radius': 'getBlastRadius',
    'dead-code': 'getDeadCode',
    complexity: 'getComplexity',
    outline: 'getFileOutline',
    churn: 'getChurn',
    hotspots: 'getHotspots',
    cycles: 'getDependencyCycles',
    importance: 'getSymbolImportance',
    coupling: 'getCouplingMetrics',
    extractable: 'getExtractionCandidates',
    hierarchy: 'getClassHierarchy',
    'signal-chains': 'getSignalChains',
    'layer-violations': 'getLayerViolations',
    winnow: 'winnow',
    'ast-patterns': 'astPatterns',
    provenance: 'getProvenance',
    untested: 'getUntestedSymbols',
    'pr-risk': 'getPrRiskProfile',
  };
  const internalName = toolMap[toolName] || toolName;

  const wrapped = responseMeta.buildEnvelope({
    toolName: internalName,
    data,
    db,
    repoId: repoRow.id,
    repoPath: repoRow.path,
    storedHeadCommit: repoRow.head_commit || null,
    startTime,
  });

  if (format === 'compact') {
    wrapped.data = wireFormat.compactResponse(wrapped.data, { stripFields: _STRIP_FIELDS });
  } else if (format === 'auto') {
    const autoFmt = wireFormat.autoFormat(wrapped.data);
    if (autoFmt === 'compact') {
      wrapped.data = wireFormat.compactResponse(wrapped.data, { stripFields: _STRIP_FIELDS });
    }
  }
  // Format === 'json' (default) — no transformation

  return wrapped;
}

// Track the global --format flag for all analysis subcommands
let _globalFormat = 'json'; // Set by parseArgs at dispatch time

/* ── dispatch ─────────────────────────────────────────────── */
const commands = {
  'session-start': sessionStart,
  'session-end': sessionEnd,
  save,
  search,
  context,
  get,
  update,
  delete: del,
  timeline,
  'suggest-topic-key': suggestTopicKey,
  'save-prompt': savePrompt,
  'capture-passive': capturePassive,
  stats: getStats,
  'session-summary': sessionSummary,
  'link-symbol': linkSymbol,
  'auto-link': autoLink,
  'adjust-trust': adjustTrust,
  'record-recall': recordRecall,
  'trust-recovery': trustRecovery,
  'stale-links': staleLinks,
  'sync-code-trust': syncCodeTrust,
  'list-projects': listProjects,
  // ── v4 workspace commands ──
  'list-workspaces': () => listWorkspaces(),
  'create-workspace': (args) => createWorkspace(args.name),
  'archive-workspace': (args) => archiveWorkspace(args.name),
  'symbol-cluster': symbolCluster,
  related,
  'check-dup': (args) => checkDuplicate(args.title, args.type, args.project, args['topic-key']),
  'mark-dup': markDuplicate,
  'auto-recover': autoRecover,
  'save-workflow': saveWorkflow,
  'record-step': recordStep,
  'step-outcome': stepOutcome,
  'get-workflow': getWorkflow,
  'recover-orphans': recoverOrphans,
  init: initDb,
  compact,
  // ── v3 code indexing commands ──
  'index-repo': (args) => {
    const repoPath = args.path;
    if (!repoPath) {jsonErr('Usage: node memory-store.js index-repo --path <path> [--name NAME]');}
    const repoName = args.name || path.basename(repoPath);
    return indexRepoInternal(repoPath, repoName);
  },
  'reindex-repo': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js reindex-repo --repo <repo-name> [--mode full|incremental]');}
    return reindexRepoInternal(repo, args.mode || 'incremental');
  },
  'search-code': (args) => {
    const query = args.query;
    if (!query)
      {jsonErr('Usage: node memory-store.js search-code --query <text> [--repo NAME] [--kind TYPE] [--max-results N]');}
    return searchCode(query, args.repo || null, args.kind || null, parseInt(args['max-results'] || '20', 10));
  },
  'get-code-source': (args) => {
    const repo = args.repo;
    const file = args.file;
    const name = args.name;
    if (!repo || !file || !name)
      {jsonErr('Usage: node memory-store.js get-code-source --repo NAME --file PATH --name SYMBOL');}
    return getCodeSource(repo, file, name);
  },
  'list-code-repos': () => listCodeReposInternal(),
  'remove-code-repo': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js remove-code-repo --repo <repo-name>');}
    return removeCodeRepoInternal(repo);
  },

  // ── v5: Code analysis subcommands ──

  'import-graph': (args) => {
    const repo = args.repo;
    if (!repo)
      {jsonErr(
        'Usage: node memory-store.js import-graph --repo X [--file F] [--direction imports|importers|both] [--depth N]',
      );}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getImportGraph(db, repoRow[0].id, {
      file: args.file || null,
      direction: args.direction || 'both',
      depth: parseInt(args.depth || '1'),
    });
  },

  'call-hierarchy': (args) => {
    const repo = args.repo;
    const symbol = args.symbol;
    if (!repo || !symbol)
      {jsonErr(
        'Usage: node memory-store.js call-hierarchy --symbol S --repo X [--direction callers|callees] [--depth N]',
      );}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found`);}
    return codeAnalysis.getCallHierarchy(db, repoRow[0].id, {
      symbol,
      direction: args.direction || 'callers',
      depth: parseInt(args.depth || '3'),
    });
  },

  'blast-radius': (args) => {
    const repo = args.repo;
    const symbol = args.symbol;
    if (!repo || !symbol) {jsonErr('Usage: node memory-store.js blast-radius --symbol S --repo X [--depth N]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found`);}
    return codeAnalysis.getBlastRadius(db, repoRow[0].id, {
      symbol,
      depth: parseInt(args.depth || '3'),
    });
  },

  'dead-code': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js dead-code --repo X [--min-confidence 0.5]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found`);}
    return codeAnalysis.getDeadCode(db, repoRow[0].id, {
      minConfidence: parseFloat(args['min-confidence'] || '0.5'),
      includeTests: args['include-tests'] === 'true',
    });
  },

  complexity: (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js complexity --repo X [--symbol S | --file F]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found`);}
    const symbolId = args.symbol
      ? db.prepare('SELECT id FROM code_symbols WHERE repo_id = ? AND name = ?').get(repoRow[0].id, args.symbol)?.id
      : null;
    return codeAnalysis.getComplexity(db, repoRow[0].id, symbolId);
  },

  outline: (args) => {
    const repo = args.repo;
    const file = args.file;
    if (!repo || !file) {jsonErr('Usage: node memory-store.js outline --file F --repo X');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found`);}
    return codeAnalysis.getFileOutline(db, repoRow[0].id, file);
  },

  churn: (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js churn --repo X [--file F] [--days 90] [--refresh]');}
    const repoRow = sqlJson('SELECT id, path FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found`);}
    return gitAnalysis.getChurn(
      db,
      repoRow[0].id,
      args.file || '__all__',
      parseInt(args.days || '90'),
      args.refresh === 'true',
    );
  },

  hotspots: (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js hotspots --repo X [--top N] [--days N]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getHotspots(db, repoRow[0].id, {
      top: args.top ? parseInt(args.top) : 20,
      days: args.days ? parseInt(args.days) : 90,
    });
  },

  cycles: (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js cycles --repo X');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getDependencyCycles(db, repoRow[0].id);
  },

  importance: (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js importance --repo X [--top N] [--scope dir/]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getSymbolImportance(db, repoRow[0].id, {
      top: args.top ? parseInt(args.top) : 20,
      scope: args.scope || null,
    });
  },

  coupling: (args) => {
    const repo = args.repo;
    if (!repo)
      {jsonErr('Usage: node memory-store.js coupling --repo X [--file F] [--sort-by instability|afferent|efferent]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getCouplingMetrics(db, repoRow[0].id, {
      file: args.file || null,
      minCa: args['min-ca'] ? parseInt(args['min-ca']) : 0,
      sortBy: args['sort-by'] || 'instability',
    });
  },

  extractable: (args) => {
    const repo = args.repo;
    if (!repo)
      {jsonErr('Usage: node memory-store.js extractable --repo X [--min-complexity N] [--min-callers N] [--top N]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getExtractionCandidates(db, repoRow[0].id, {
      minComplexity: args['min-complexity'] ? parseInt(args['min-complexity']) : 5,
      minCallers: args['min-callers'] ? parseInt(args['min-callers']) : 2,
      top: args.top ? parseInt(args.top) : 20,
    });
  },

  hierarchy: (args) => {
    const repo = args.repo;
    const symbol = args.symbol || args.class;
    if (!repo)
      {jsonErr('Usage: node memory-store.js hierarchy --repo X --symbol S [--direction both|ancestors|descendants]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getClassHierarchy(db, repoRow[0].id, {
      class: args.class,
      symbol: args.symbol,
      direction: args.direction || 'both',
    });
  },

  'signal-chains': (args) => {
    const repo = args.repo;
    if (!repo)
      {jsonErr('Usage: node memory-store.js signal-chains --repo X [--kind http|cli] [--symbol S] [--max-depth N]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    return codeAnalysis.getSignalChains(db, repoRow[0].id, {
      kind: args.kind || null,
      symbol: args.symbol || null,
      maxDepth: args['max-depth'] ? parseInt(args['max-depth']) : 5,
    });
  },

  'layer-violations': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js layer-violations --repo X [--rules JSON]');}
    const repoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Repo "${repo}" not found. Run index-repo first.`);}
    let rules = null;
    if (args.rules) {
      try {
        rules = JSON.parse(args.rules);
      } catch (e) {
        jsonErr(`Invalid rules JSON: ${e.message}`);
      }
    }
    return codeAnalysis.getLayerViolations(db, repoRow[0].id, { rules });
  },

  // ── v6: Winnow multi-axis query ──

  winnow: (args) => _dispatch(args.repo, (repoRow) =>
      codeAnalysis.winnow(db, repoRow.id, {
        kind: args.kind || null,
        minComplexity: args['min-complexity'] ? parseInt(args['min-complexity']) : null,
        minChurn: args['min-churn'] ? parseInt(args['min-churn']) : null,
        minPageRank: args['min-pagerank'] ? parseFloat(args['min-pagerank']) : null,
        minCallers: args['min-callers'] ? parseInt(args['min-callers']) : null,
        fileGlob: args['file-glob'] || null,
        nameRegex: args['name-regex'] || null,
        sortBy: args['sort-by'] || 'pagerank',
        top: args.top ? parseInt(args.top) : 20,
      })
    ),

  // ── v6: AST pattern matching ──

  'ast-patterns': (args) => _dispatch(args.repo, (repoRow) =>
      astPatterns.scanAstPatterns(db, repoRow.id, {
        category: args.category || 'all',
        patterns: args.pattern ? args.pattern.split(',').map(s => s.trim()) : [],
        limit: args.limit ? parseInt(args.limit) : 200,
      })
    ),

  // ── v6: Symbol provenance ──

  provenance: (args) => _dispatch(args.repo, (repoRow) =>
      gitAnalysis.getProvenance(db, repoRow.id, args.symbol)
    ),

  // ── v6: Untested symbols + PR risk ──

  untested: (args) => _dispatch(args.repo, (repoRow) =>
      codeAnalysis.getUntestedSymbols(db, repoRow.id, {
        minConfidence: args['min-confidence'] ? parseFloat(args['min-confidence']) : 0.5,
        includePrivate: args['include-private'] === 'true',
      })
    ),

  'pr-risk': (args) => _dispatch(args.repo, (repoRow) =>
      codeAnalysis.getPrRiskProfile(db, repoRow.id, {
        branch: args.branch || 'HEAD',
        base: args.base || 'main',
      })
    ),

  // ── v5.2: Doc analytics subcommands ──

  'doc-orphans': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js doc-orphans --repo X [--include-same-doc]');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.getOrphanSections(db, repoRow[0].id, {
      includeSameDoc: args['include-same-doc'] === 'true',
    });
  },

  'doc-coverage': (args) => {
    const codeRepo = args.repo;
    const docRepo = args['doc-repo'] || codeRepo;
    if (!codeRepo) {jsonErr('Usage: node memory-store.js doc-coverage --repo X [--doc-repo Y]');}
    const codeRepoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [codeRepo]);
    if (!codeRepoRow.length) {jsonErr(`Code repo "${codeRepo}" not found. Run index-repo first.`);}
    const docRepoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [docRepo]);
    if (!docRepoRow.length) {jsonErr(`Doc repo "${docRepo}" not found. Run index-docs first.`);}
    return docIndexer.getDocCoverage(db, codeRepoRow[0].id, docRepoRow[0].id);
  },

  'stale-pages': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js stale-pages --repo X');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found. Run index-docs first.`);}
    return docIndexer.getStalePages(db, repoRow[0].id);
  },

  'doc-duplicates': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js doc-duplicates --repo X');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found. Run index-docs first.`);}
    return docIndexer.getDuplicateSections(db, repoRow[0].id);
  },

  // ── v5: Doc indexing subcommands ──

  'index-docs': (args) => {
    const docPath = args.path;
    const name = args.name;
    if (!docPath || !name) {jsonErr('Usage: node memory-store.js index-docs --path P --name X [--ignore GLOB]');}
    return docIndexer.indexDocs(db, path.resolve(docPath), name, args.ignore || null);
  },

  'reindex-docs': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js reindex-docs --repo X [--mode full|incremental] [--ignore GLOB]');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.reindexDocs(db, repoRow[0].id, args.mode || 'full', args.ignore || null);
  },

  'doc-search': (args) => {
    const repo = args.repo;
    const query = args.query;
    if (!repo || !query) {jsonErr('Usage: node memory-store.js doc-search --query Q --repo X [--level N] [--role TYPE]');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.searchDocs(db, repoRow[0].id, query, {
      level: args.level ? parseInt(args.level) : null,
      role: args.role || null,
    });
  },

  'doc-outline': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js doc-outline --repo X [--file F]');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.getDocOutline(db, repoRow[0].id, args.file || null);
  },

  backlinks: (args) => {
    const repo = args.repo;
    const filePath = args.path;
    if (!repo || !filePath) {jsonErr('Usage: node memory-store.js backlinks --repo X --path F');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.getBacklinks(db, repoRow[0].id, filePath);
  },

  'broken-links': (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js broken-links --repo X');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return { broken_links: docIndexer.getBrokenLinks(db, repoRow[0].id) };
  },

  glossary: (args) => {
    const repo = args.repo;
    if (!repo) {jsonErr('Usage: node memory-store.js glossary --repo X [--term T]');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.lookupTerm(db, repoRow[0].id, args.term || null);
  },

  'tutorial-path': (args) => {
    const repo = args.repo;
    const section = args.section;
    if (!repo || !section) {jsonErr('Usage: node memory-store.js tutorial-path --section S --repo X');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.getTutorialPath(db, repoRow[0].id, parseInt(section));
  },

  'code-examples': (args) => {
    const repo = args.repo;
    const query = args.query;
    if (!repo || !query) {jsonErr('Usage: node memory-store.js code-examples --query Q --repo X [--lang X]');}
    const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repo]);
    if (!repoRow.length) {jsonErr(`Doc repo "${repo}" not found`);}
    return docIndexer.findCodeExamples(db, repoRow[0].id, query, args.lang || null);
  },
};

const args = parseArgs(process.argv);
const cmd = process.argv[2];

// Code analysis tools that receive _meta envelope + format support
const _ANALYSIS_TOOLS = new Set([
  'import-graph', 'call-hierarchy', 'blast-radius', 'dead-code', 'complexity', 'outline',
  'churn', 'hotspots', 'cycles', 'importance', 'coupling', 'extractable', 'hierarchy',
  'signal-chains', 'layer-violations', 'winnow', 'ast-patterns', 'provenance', 'untested', 'pr-risk',
]);

(async () => {
  ensureDb();
  db = getDb();
  _globalFormat = args.format || 'json';

  if (cmd && commands[cmd]) {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const result = await commands[cmd](args);

    // Wrap code analysis results with _meta envelope
    if (_ANALYSIS_TOOLS.has(cmd) && !result.error) {
      const repoName = args.repo;
      if (repoName) {
        const repoRow = sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
        if (repoRow.length > 0) {
          jsonOut(_wrapAnalysis(cmd, result, repoRow[0], startTime, _globalFormat));
          return;
        }
        // For tools querying churn (which has a different repo resolution),
        // Still try to wrap but fall through gracefully
      }
    }

    jsonOut(result);
  } else {
    console.error(
      `Usage: node memory-store.js <subcommand> [--option value ...]\n` +
        `Subcommands: ${ 
        Object.keys(commands).join(', ')}`,
    );
    process.exit(1);
  }
})();
