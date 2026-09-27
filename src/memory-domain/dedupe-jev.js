// src/memory-domain/dedupe-jev.js
// Slice D: semantic dedup verification — opt-in, advisory. Takes trigram
// candidates from checkDuplicate and judge-verifies 'same decision?' per pair;
// verified results carry a probability usable as markDuplicate confidence.

const { createJudge } = require('../judgment');
const { createJevAdapter } = require('../judgment/adapters/jev');
const { getConfig } = require('../../config');
const { chunk, capText } = require('../judgment/internal');

const BATCH = 10;

function dedupeJevEnabled() {
  const cfg = getConfig().judgment || {};
  return cfg.provider === 'jev' && !!process.env.TYPESAFE_API_KEY && !(cfg.disables && cfg.disables.dedupe);
}

function buildJudge(args) {
  if (args && args._judge) return args._judge;
  const adapters =
    (getConfig().judgment || {}).provider === 'jev'
      ? { jev: createJevAdapter({ apiKey: process.env.TYPESAFE_API_KEY }) }
      : {};
  return createJudge({ config: getConfig(), adapters });
}

/**
 * jevVerifyDuplicates(deps, candidates, args) — async, READ-ONLY (never writes).
 * candidates: [{id, title, content?}] from checkDuplicate. Returns
 * {verified: [{id, title, p, confidence, same: boolean}], unavailable?}.
 */
async function jevVerifyDuplicates(deps, candidates, args = {}) {
  const verified = [];
  const rows = candidates || [];
  if (rows.length === 0) return { verified };
  const judge = buildJudge(args);
  const questions = rows.map((c, i) => ({
    id: `dup-${i}`,
    judgment: { kind: 'probability', claim: `The new memory duplicates memory #${c.id} (${capText(c.title, 60)})` },
    instructions:
      'Decide whether the new memory records the SAME decision/content as the existing one — nothing semantically new. p = probability of duplication.',
    state: {
      existing: { id: c.id, title: c.title, content: capText(c.content || '', 400) },
      incoming: { title: args.incomingTitle || '', content: capText(args.incomingContent || '', 400) },
    },
  }));
  try {
    for (const batch of chunk(questions, BATCH)) {
      const result = await judge(batch, { surface: 'dedupe' });
      if (!result || result.status !== 'ok') return { verified, unavailable: true };
      for (const a of result.answers) {
        const row = rows[Number(a.id.split('-')[1])];
        verified.push({ id: row.id, title: row.title, p: a.p, confidence: a.confidence, same: a.p >= 0.5 });
      }
    }
  } catch {
    return { verified, unavailable: true };
  }
  return { verified };
}

module.exports = { jevVerifyDuplicates, dedupeJevEnabled };
