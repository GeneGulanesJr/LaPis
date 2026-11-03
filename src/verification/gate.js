// Stop gate: decide whether an agent may finish. It blocks only on what this
// session caused or left unchecked, so a project that was already failing
// does not trap the agent:
//   - new failures: failing checks not in the session-start baseline, for
//     checkers that had a run when the session started;
//   - unchecked edits: files the agent edited after the checker's last run.
// Nothing blocks when the agent edited no files. Hosts cap repeated blocks.

const path = require('path');

// Which edited files each checker covers.
const COVERS = {
  tsc: /\.(?:[cm]?tsx?)$/i,
  eslint: /\.(?:[cm]?[jt]sx?|vue|svelte)$/i,
  vitest: /\.(?:[cm]?[jt]sx?|vue|svelte)$/i,
  jest: /\.(?:[cm]?[jt]sx?|vue|svelte)$/i,
  pytest: /\.py$/i,
  gnatprove: /\.(?:ads|adb|adc|gpr)$/i,
};
const MAX_LISTED = 5;

// Each latest run, plus the last full run behind a partial one: running one
// passing test file must not hide what the full suite last reported.
function runsWithFull(state) {
  return ((state && state.runs) || []).flatMap((run) => {
    const full = run.partial && run.partial.full_run;
    return full ? [run, { verifier: run.verifier, units: full.failures, totals: full.totals, fromFull: true }] : [run];
  });
}

function fullRunKeys(state) {
  return new Set(failureKeys({ runs: runsWithFull(state).filter((r) => r.fromFull) }));
}

function failureKeys(state) {
  const keys = [];
  for (const run of runsWithFull(state)) {
    let unitKeys = 0;
    for (const u of run.units) {
      for (const c of u.open_checks) {
        if (c.status === 'unproved' || c.status === 'flow-error') {
          // No line number: an unrelated edit above a failure must not make it "new".
          keys.push(`${run.verifier}|${c.file || u.file}|${c.rule || ''}|${c.message || ''}`);
          unitKeys++;
        }
      }
    }
    if (!unitKeys && run.totals && run.totals.unproved) {
      keys.push(`${run.verifier}|*|failing`);
    }
  }
  return [...new Set(keys)];
}

/** The baseline a host stores at session start. */
function gateBaseline(state) {
  return { keys: failureKeys(state), verifiers: ((state && state.runs) || []).map((r) => r.verifier) };
}

function relEdited(root, editedFiles) {
  return [
    ...new Set(
      (editedFiles || [])
        .map((f) => path.relative(root, path.resolve(root, f)).replace(/\\/g, '/'))
        .filter((f) => f && !f.startsWith('../')),
    ),
  ];
}

/**
 * @param state proof-state result for the session's repo
 * @param baseline { keys, verifiers } from gateBaseline at session start
 * @param editedFiles files the agent edited this session (absolute or repo-relative)
 * @returns { block: false } | { block: true, reason, fresh, unchecked }
 */
function evaluateGate(state, baseline, editedFiles) {
  if (!state || !state.repo_root || !Array.isArray(state.runs) || !state.runs.length) {
    return { block: false };
  }
  const edited = relEdited(state.repo_root, editedFiles);
  if (!edited.length) {
    return { block: false };
  }
  const base = new Set((baseline && baseline.keys) || []),
    known = new Set((baseline && baseline.verifiers) || []),
    fresh = failureKeys(state).filter((k) => !base.has(k) && known.has(k.split('|')[0])),
    unchecked = [];
  for (const run of state.runs) {
    const covers = COVERS[run.verifier];
    if (!covers) {
      continue;
    }
    const since = run.changed_since === null ? null : new Set(run.changed_since),
      files = edited.filter((f) => covers.test(f) && (since === null || since.has(f)));
    if (files.length) {
      unchecked.push({ verifier: run.verifier, files });
    }
  }
  if (!fresh.length && !unchecked.length) {
    return { block: false };
  }
  const lines = ['LaPis check gate: not done yet.'];
  for (const u of unchecked) {
    const shown = u.files.slice(0, MAX_LISTED).join(', ') + (u.files.length > MAX_LISTED ? ', …' : '');
    lines.push(`- Re-run ${u.verifier}: you edited ${shown} after its last run.`);
  }
  if (fresh.length) {
    lines.push('- New failures since the session started:');
    for (const k of fresh.slice(0, MAX_LISTED)) {
      const [verifier, file, rule, message] = k.split('|');
      lines.push(
        `  - ${verifier} ${file === '*' ? '' : `${file} `}${[rule, message].filter(Boolean).join(' ')}`.trimEnd(),
      );
    }
    if (fresh.length > MAX_LISTED) {
      lines.push(`  - … and ${fresh.length - MAX_LISTED} more`);
    }
    const fromFull = fullRunKeys(state);
    if (fresh.some((k) => fromFull.has(k))) {
      lines.push('  (Some come from the last full run: a partial run cannot clear them; run the full suite.)');
    }
  }
  lines.push(
    'Fix them and re-run the checks. If a failure is unrelated to your change or cannot be fixed, say so to the user explicitly.',
  );
  return { block: true, reason: lines.join('\n'), fresh, unchecked };
}

module.exports = { failureKeys, gateBaseline, evaluateGate, COVERS };
