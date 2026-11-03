const { TRUST_DELTA } = require('../../constants'),
  { detectChangedSymbols } = require('./change-detector'),
  { evaluateTrustSync, stripOperations } = require('./trust-policy'),
  TRUST_SYNC_METHODS = [
    'autoLinkMemories',
    'linkSymbol',
    'findUnlinked',
    'insertSymbolLink',
    'adjustTrust',
    'recordRecall',
    'getStaleLinks',
    'getAnchoredLinks',
    'updateLinkTrust',
    'insertTrustAdjustment',
    'getRecalledMemoryIds',
    'updateLinkTrustByMemoryId',
    'getSymbolsForMemory',
    'getSymbolCluster',
    'getRelatedMemories',
  ];

function assertRepositoryMethods(repository, requiredMethods) {
  const missing = requiredMethods.filter((method) => typeof repository[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`trust-sync repository missing methods: ${missing.join(', ')}`);
  }
}

function createLegacyTrustSyncRepository(deps, requiredMethods) {
  const hasLegacyMethod = TRUST_SYNC_METHODS.some((method) => typeof deps[method] === 'function');
  if (!hasLegacyMethod) {
    return null;
  }

  assertRepositoryMethods(deps, requiredMethods);
  return Object.fromEntries(
    TRUST_SYNC_METHODS.map((method) => [
      method,
      (params) => {
        if (typeof deps[method] !== 'function') {
          throw new Error(`trust-sync repository missing methods: ${method}`);
        }
        return deps[method](params);
      },
    ]),
  );
}

function getTrustSyncRepository(deps, requiredMethods = TRUST_SYNC_METHODS) {
  if (deps.trustSyncRepository) {
    assertRepositoryMethods(deps.trustSyncRepository, requiredMethods);
    return deps.trustSyncRepository;
  }
  if (deps.repositories && deps.repositories.trustSync) {
    assertRepositoryMethods(deps.repositories.trustSync, requiredMethods);
    return deps.repositories.trustSync;
  }

  const legacyRepository = createLegacyTrustSyncRepository(deps, requiredMethods);
  if (legacyRepository) {
    return legacyRepository;
  }
  throw new Error('trust-sync repository is required');
}

function linkSymbol(deps, args) {
  const memoryId = args['memory-id'] || args.memoryId,
    symbolId = args['symbol-id'] || args.symbolId,
    repo = args.repo,
    trust = parseFloat(args.trust || '0.5'),
    // File path of the linked symbol — enables path-aware trust matching
    // (#300). Accept relative (repo-root) or absolute paths.
    symbolPath = args.file || args['file-path'] || args.symbolPath || null;
  if (!memoryId) {
    return deps.jsonErrNoExit('--memory-id required');
  }
  if (!repo) {
    return deps.jsonErrNoExit('--repo required');
  }
  return getTrustSyncRepository(deps, ['linkSymbol']).linkSymbol({
    memoryId,
    symbolId,
    repo,
    trust,
    symbolPath,
  });
}

function autoLink(deps, args) {
  const project = args.project;
  if (!project) {
    return deps.jsonErrNoExit('--project required');
  }
  const repository = getTrustSyncRepository(deps, ['autoLinkMemories', 'deletePlaceholderLinks']);
  // Legacy '__unlinked__' placeholder rows hid memories from linking (#301); purge them first.
  repository.deletePlaceholderLinks(project);
  // The project's code index has the project's name, so the project doubles as the repo name.
  const { total, linked, links } = repository.autoLinkMemories(project),
    left = total - linked;

  return {
    ok: true,
    linked,
    links,
    total,
    message:
      total === 0
        ? 'No unlinked memories (or no code index named after this project).'
        : `Linked ${linked} of ${total} memories to code (${links} links); ${left} name no indexed file or symbol and stay unlinked.`,
  };
}

// Best effort: a failed link must not fail the trust sync it rides on.
function linkNewMemories(deps, repo) {
  try {
    return getTrustSyncRepository(deps, ['autoLinkMemories']).autoLinkMemories(repo);
  } catch {
    return null;
  }
}

function adjustTrust(deps, args) {
  const memoryId = args['memory-id'] || args.memoryId,
    delta = parseFloat(args.delta || '0'),
    reason = args.reason || 'manual',
    newTrust = memoryId
      ? getTrustSyncRepository(deps, ['adjustTrust']).adjustTrust({ memoryId, delta, reason })
      : undefined;
  if (!memoryId) {
    return deps.jsonErrNoExit('--memory-id required');
  }
  if (newTrust === null) {
    return { ok: true, memoryId, newTrust: null, delta, reason, warning: 'No symbol link found for this memory' };
  }
  return { ok: true, memoryId, newTrust, delta, reason };
}

function recordRecall(deps, args) {
  const sessionId = args['session-id'] || args.sessionId,
    memoryId = args['memory-id'] || args.memoryId;
  if (!sessionId || !memoryId) {
    return deps.jsonErrNoExit('--session-id and --memory-id required');
  }
  getTrustSyncRepository(deps, ['recordRecall']).recordRecall({ sessionId, memoryId });
  return { ok: true, sessionId, memoryId };
}

function staleLinks(deps, args) {
  const repo = args.repo,
    links = repo ? getTrustSyncRepository(deps, ['getStaleLinks']).getStaleLinks(repo) : undefined;
  if (!repo) {
    return deps.jsonErrNoExit('--repo required');
  }
  return { links, total: links.length };
}

// Links new memories after trust moved to the current head, so changes made before a link existed never lower it.
function syncCodeTrust(deps, args) {
  const result = syncTrustToHead(deps, args);
  if (result && !result.error && args.repo) {
    result.auto_linked = linkNewMemories(deps, args.repo);
  }
  return result;
}

function syncTrustToHead(deps, args) {
  const repo = args.repo,
    detected = repo ? detectChangedSymbols(deps, repo) : undefined;
  if (!repo) {
    return deps.jsonErrNoExit('Missing --repo');
  }

  // Try new git-based detection first
  if (detected.error) {
    return detected.error;
  }

  // HEAD unchanged — nothing to do
  if (detected.message) {
    return detected;
  }

  // No changed symbols in the index — update trust_head and return
  if (detected.changedSet.size === 0) {
    const tx = deps.withTransaction || require('../../db').withTransaction;
    tx(() => {
      deps.sqlRun('UPDATE code_repos SET trust_head = ? WHERE name = ?', [detected.new_head, repo]);
    });
    return {
      ok: true,
      repo,
      message: 'Files changed but no indexed symbols affected',
      changed_files: detected.changed_files,
      old_head: detected.old_head,
      new_head: detected.new_head,
    };
  }

  // Evaluate trust adjustments
  const repository = getTrustSyncRepository(deps, ['getAnchoredLinks', 'updateLinkTrust', 'insertTrustAdjustment']),
    allLinks = repository.getAnchoredLinks(repo),
    evaluated = evaluateTrustSync(allLinks, detected.changedSet, detected.changed_paths, detected.repo_path),
    applyTrustUpdates = () => {
      for (const operation of evaluated.operations) {
        repository.updateLinkTrust({
          memoryId: operation.link.memory_id,
          symbolId: operation.link.symbol_id,
          newTrust: operation.newTrust,
        });
        repository.insertTrustAdjustment({
          memoryId: operation.link.memory_id,
          reason: operation.reason,
          delta: operation.delta,
        });
      }
      deps.sqlRun('UPDATE code_repos SET trust_head = ? WHERE name = ?', [detected.new_head, repo]);
    },
    tx = deps.withTransaction || require('../../db').withTransaction,
    result = (() => {
      tx(applyTrustUpdates);

      return stripOperations(evaluated);
    })();
  result.changed_symbols = detected.changedSet.size;
  result.changed_files = detected.changed_files;
  result.old_head = detected.old_head;
  result.new_head = detected.new_head;
  return result;
}

function trustRecovery(deps, args) {
  const sessionId = parseInt(args.session, 10),
    repository = sessionId
      ? getTrustSyncRepository(deps, ['getRecalledMemoryIds', 'updateLinkTrustByMemoryId', 'insertTrustAdjustment'])
      : undefined,
    recalled = sessionId ? repository.getRecalledMemoryIds(sessionId) : undefined;
  if (!sessionId) {
    return deps.jsonErrNoExit('Missing --session');
  }

  let recovered = 0;
  // One transaction for the whole recovery pass: the loop used to issue two
  // autocommitted statements per recalled memory (2N commits per session end).
  // Same pattern as syncCodeTrust above.
  const tx = deps.withTransaction || require('../../db').withTransaction;
  tx(() => {
    for (const row of recalled) {
      const memoryId = String(row.memory_id);
      repository.updateLinkTrustByMemoryId({ memoryId, newTrust: TRUST_DELTA.PASSIVE_SURVIVAL });
      repository.insertTrustAdjustment({
        memoryId,
        reason: 'passive_survival',
        delta: TRUST_DELTA.PASSIVE_SURVIVAL,
      });
      recovered++;
    }
  });
  return { ok: true, memoriesRecovered: recovered };
}

module.exports = {
  TRUST_SYNC_METHODS,
  assertRepositoryMethods,
  getTrustSyncRepository,
  linkSymbol,
  autoLink,
  adjustTrust,
  recordRecall,
  staleLinks,
  syncCodeTrust,
  trustRecovery,
};
