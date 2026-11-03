// The one renderer for check/proof state in injected context (Claude Code,
// Pi and Hermes all reach it through buildContextBlock). It goes before the
// memories so the context cap cannot cut it, and it labels every result as
// the state at the last run, not proof of the current code.

const MAX_CHECKS_SHOWN = 3,
  MAX_LINE = 220;

function age(ingestedAt, now) {
  const t = Date.parse(`${String(ingestedAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) {
    return '';
  }
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function failures(run) {
  const out = [];
  for (const u of run.units) {
    for (const c of u.open_checks) {
      if (c.status === 'unproved' || c.status === 'flow-error') {
        out.push(
          `${c.file || u.file}${c.line ? `:${c.line}` : ''} ${[c.rule, c.message].filter(Boolean).join(' ')}`.trim(),
        );
      }
    }
  }
  return out;
}

function renderRun(run, now) {
  const t = run.totals || {},
    fails = failures(run),
    stale = (run.summary && run.summary.stale) || 0,
    changed = run.changed_since === null ? null : (run.changed_since || []).length,
    when = age(run.ingested_at, now),
    head = `- **${run.verifier}**${when ? ` (${when})` : ''}`;
  let status;
  if (t.unproved || fails.length) {
    const n = t.unproved || fails.length;
    status = `✗ ${n} failing${t.proved ? `, ${t.proved} passing` : ''}: ${fails.slice(0, MAX_CHECKS_SHOWN).join('; ')}${fails.length > MAX_CHECKS_SHOWN ? '; …' : ''}`;
  } else {
    status = `✓ clean${t.justified ? ` (${t.justified} justified, not proved)` : ''}`;
  }
  const notes = [];
  if (run.partial) {
    notes.push(`partial run: ${run.partial.checked} of ${run.partial.of} ${run.partial.unit}`);
  }
  if (stale) {
    notes.push(`${stale} stale`);
  }
  if (run.stale_reason) {
    notes.push(run.stale_reason);
  } else if (changed) {
    notes.push(`${changed} file${changed === 1 ? '' : 's'} changed since — re-run to confirm`);
  }
  const line = clip(`${head}: ${status}${notes.length ? ` (${notes.join('; ')})` : ''}`),
    full = run.partial && run.partial.full_run;
  if (!full) {
    return [line];
  }
  // A partial run says nothing about what it skipped: keep the last full run's verdict in view.
  const fullFails = failures({ units: full.failures }),
    fullWhen = age(full.ingested_at, now),
    fullStatus = fullFails.length
      ? `✗ ${full.totals.unproved || fullFails.length} failing: ${fullFails.slice(0, MAX_CHECKS_SHOWN).join('; ')}${fullFails.length > MAX_CHECKS_SHOWN ? '; …' : ''}`
      : '✓ clean';
  return [line, clip(`  - last full run${fullWhen ? ` (${fullWhen})` : ''}: ${fullStatus}`)];
}

function clip(line) {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** Context lines for a proof-state result; [] when there are no runs. */
function renderCheckState(state, now = Date.now()) {
  if (!state || !Array.isArray(state.runs) || !state.runs.length) {
    return [];
  }
  return [
    '### Checks (last runs — hints, not proof; re-run after editing)',
    ...state.runs.flatMap((r) => renderRun(r, now)),
    '',
  ];
}

module.exports = { renderCheckState };
