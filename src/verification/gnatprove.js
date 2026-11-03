// GNATprove adapter: turn the gnatprove output folder (obj/.../gnatprove/, one
// <unit>.spark JSON per compilation unit plus gnatprove.sarif) into the
// verifier-neutral results format that results.js validates and stores.
// File names in .spark are basenames; results.js resolves them to repo paths.

const fs = require('fs'),
  path = require('path');

// Read the files this adapter needs from a gnatprove output folder.
function readReportDir(dir) {
  const files = new Map();
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.spark') || name === 'gnatprove.sarif') {
      files.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return files;
}

function sarifInfo(text) {
  try {
    const run = JSON.parse(text).runs[0];
    return { version: run.tool.driver.version || null, ranAt: run.invocations?.[0]?.endTimeUtc || null };
  } catch {
    return { version: null, ranAt: null }; // version and time are optional
  }
}

function entityId(item) {
  return String(item && typeof item === 'object' ? item.entity : item).trim();
}

// One .spark file → its analyzed units. Entities with spark mode "no"
// (SPARK_Mode => Off) were not analyzed and are left out; "spec" means the
// body was skipped, so nothing in it was proved.
function unitsFromSpark(name, s) {
  if (!s || typeof s.entities !== 'object') {
    throw new Error(`${name}: not a GNATprove .spark file (no "entities")`);
  }
  const units = new Map();
  for (const [id, ent] of Object.entries(s.entities)) {
    const mode = s.spark?.[id];
    if (mode !== 'all' && mode !== 'spec') {
      continue;
    }
    const sloc = ent.sloc?.[0] || {};
    units.set(id.trim(), {
      file: sloc.file,
      unit: ent.name,
      line: sloc.line ?? null,
      analyzed: mode === 'all',
      proved: 0,
      unproved: 0,
      justified: 0,
      flow_errors: 0,
      open_checks: [],
    });
  }

  for (const [kind, list] of [
    ['proof', s.proof],
    ['flow', s.flow],
  ]) {
    for (const m of list || []) {
      const u = units.get(entityId(m));
      if (!u || m.severity === 'warning') {
        continue; // flow warnings are not checks
      }
      const check = { file: m.file, line: m.line ?? null, rule: m.rule || '', message: m.message?.text || '' };
      if (m.suppressed !== undefined) {
        u.justified++;
        u.open_checks.push({ ...check, status: 'justified', reason: String(m.suppressed) });
      } else if (m.severity === 'info') {
        u.proved++;
      } else if (kind === 'flow') {
        u.flow_errors++;
        u.open_checks.push({ ...check, status: 'flow-error', severity: m.severity });
      } else {
        u.unproved++;
        u.open_checks.push({ ...check, status: 'unproved', severity: m.severity });
      }
    }
  }

  // pragma Assume is taken as true without proof: count it as justified, never proved.
  for (const a of s.pragma_assume || []) {
    const u = units.get(entityId(a));
    if (u) {
      u.justified++;
      u.open_checks.push({
        file: a.file,
        line: a.line ?? null,
        rule: 'PRAGMA_ASSUME',
        message: 'pragma Assume',
        status: 'assumed',
      });
    }
  }

  // shortcut: skip_proof / skip_flow_proof entry shape is assumed to carry an entity id (not seen in a real report yet), check once a Skip_Proof sample exists.
  for (const item of [...(s.skip_proof || []), ...(s.skip_flow_proof || [])]) {
    const u = units.get(entityId(item));
    if (u) {
      u.analyzed = false;
    }
  }
  return [...units.values()];
}

/** Parse the files of a gnatprove output folder (Map name → text) into the neutral format. */
function parseGnatprove(files) {
  const units = [];
  for (const [name, text] of files) {
    if (!name.endsWith('.spark')) {
      continue;
    }
    let s;
    try {
      s = JSON.parse(text);
    } catch (e) {
      throw new Error(`${name}: invalid JSON (${e.message})`, { cause: e });
    }
    units.push(...unitsFromSpark(name, s));
  }
  if (![...files.keys()].some((n) => n.endsWith('.spark'))) {
    throw new Error('no .spark files found: point --report at the gnatprove output folder (obj/.../gnatprove)');
  }
  const { version, ranAt } = files.has('gnatprove.sarif')
    ? sarifInfo(files.get('gnatprove.sarif'))
    : { version: null, ranAt: null };
  return { verifier: 'gnatprove', verifier_version: version, ran_at: ranAt, units };
}

module.exports = { readReportDir, parseGnatprove };
