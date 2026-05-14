const symDA = require('../data-access/symbols');

function linkSymbol(deps, args) {
  const { TRUST_DELTA } = require('../constants');
  const memoryId = args.memory;
  const symbolId = args.symbol;
  const repo = args.repo;
  const trust = parseFloat(args.trust || (symbolId ? '1.0' : String(TRUST_DELTA.DEFAULT_INITIAL)));
  if (!memoryId || !repo) {
    return deps.jsonErrNoExit('Missing --memory and --repo');
  }
  return symDA.linkSymbol(deps, { memoryId, symbolId, repo, trust });
}

function autoLink(deps, args) {
  const { TRUST_DELTA } = require('../constants');
  const project = args.project;
  if (!project) {
    return deps.jsonErrNoExit('Missing --project');
  }
  const unlinked = symDA.findUnlinked(deps, project);
  let linked = 0;
  for (const row of unlinked) {
    symDA.insertSymbolLink(deps, {
      memoryId: String(row.memory_id),
      symbolId: '__unlinked__',
      repo: project,
      trustScore: TRUST_DELTA.DEFAULT_INITIAL,
    });
    linked++;
  }
  return { ok: true, project, linked, unlinkedCount: unlinked.length };
}

function adjustTrust(deps, args) {
  const memoryId = args.memory;
  const reason = args.reason;
  const delta = parseFloat(args.delta);
  if (!memoryId || !reason || isNaN(delta)) {
    return deps.jsonErrNoExit('Missing --memory, --reason, --delta');
  }
  const newTrustScore = symDA.adjustTrust(deps, { memoryId, delta, reason });
  return { ok: true, memoryId, newTrustScore };
}

function recordRecall(deps, args) {
  const sessionId = parseInt(args.session);
  const memoryId = args.memory;
  if (!sessionId || !memoryId) {
    return deps.jsonErrNoExit('Missing --session and --memory');
  }
  symDA.recordRecall(deps, { sessionId, memoryId });
  return { ok: true };
}

function staleLinks(deps, args) {
  const project = args.project;
  if (!project) {
    return deps.jsonErrNoExit('Missing --project');
  }
  return symDA.getStaleLinks(deps, project);
}

module.exports = { linkSymbol, autoLink, adjustTrust, recordRecall, staleLinks };