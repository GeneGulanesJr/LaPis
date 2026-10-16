// Lazy requires for obsCmd/codeSearchService: the hook path dispatches
// `context` in a fresh process, and an eager top-level require made every
// memory-router command pay for the observation-CRUD and code-search subtrees
// (~16ms measured marginal) even when its own handler never touches them.
// commands/search stays eager — search and context both need it.
// decision.js stays eager — a small MCP-client module needed by
// buildSaveClassified for instanceof DecisionError checks.
const searchCmd = require('../../../commands/search'),
  { classify: classifyContent, autoClassify, DecisionError } = require('../../memory-domain/decision'),
  USAGE = {
    save: '--title <title> --content <content> [--type TYPE] [--project NAME] [--scope SCOPE] [--topic-key KEY] [--force] [--expires-in DUR] [--session-id ID]',
    'save-classified':
      '--title <title> --content <content> [--classification guard|moderate|triage|email|auto] [--on-injection refuse|save_as_security_block] [--type TYPE] [--project NAME] [--scope SCOPE] [--topic-key KEY] [--force] [--expires-in DUR] [--trust-score N]',
    get: '--id ID',
    update:
      '--id ID [--title T] [--content C] [--type T] [--project P] [--scope S] [--topic-key K] [--expires-in DUR] [--expires-at TS] [--clear-expiry]',
    delete: '--id ID [--hard]',
    timeline: '--id ID [--before N] [--after N]',
    search: '--query <text> [--project NAME] [--type TYPE] [--scope SCOPE] [--limit N]',
    context:
      '--query <text> [--project NAME] [--limit N] [--token-budget N] [--session-id ID] [--topic-key KEY] [--deep] [--all-projects]',
    'suggest-topic-key': '[--title T] [--content C]',
    'save-prompt': '--content <text> [--project NAME] [--session-id ID]',
    'capture-passive': '--content <text>',
    stats: '',
    'check-dup': '--title T [--type TYPE] [--project NAME] [--topic-key KEY]',
    'mark-dup': '--source ID --target ID [--confidence N]',
    'log-negative-recall': '--entries <json-array>',
  };

// Read a kebab-case arg from the args object, falling back to its
// Snake_case / camelCase spelling.
function arg(args, ...names) {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null && args[n] !== '') {
      return args[n];
    }
  }
  return undefined;
}

// Wrap commands.save so the atomic classifier can route on the outcome
// Without modifying the underlying save implementation.  Defensive
// Failure semantics (refuse vs. fall-through) live here so a single
// Failure mode cannot silently corrupt memory.
function buildSaveClassified(deps, commands) {
  async function runSave({ args, title, content, classification, confidence, override, warning }) {
    const adjusted = {
      title,
      content,
      type: arg(args, 'type') || 'manual',
      project: arg(args, 'project') || 'unknown',
      scope: arg(args, 'scope') || 'project',
      force: arg(args, 'force') === 'true' || arg(args, 'force') === true ? 'true' : undefined,
    };
    const expiresIn = arg(args, 'expires-in', 'expires_in');
    if (expiresIn) {
      adjusted['expires-in'] = expiresIn;
    }
    const topicKey = arg(args, 'topic-key', 'topic_key');
    if (topicKey || (override && override['topic-key'])) {
      adjusted['topic-key'] = topicKey || override['topic-key'];
    }
    if (override && override.type) {
      adjusted.type = override.type;
    }
    if (override && override['trust-score']) {
      adjusted['trust-score'] = override['trust-score'];
    }

    const baseResult = await commands.save(adjusted);
    if (!baseResult) {
      return baseResult;
    }
    const enriched = { ...baseResult };
    if (classification) {
      enriched.classification = classification;
    }
    if (confidence !== null && confidence !== undefined) {
      enriched.confidence = confidence;
    }
    if (warning) {
      enriched.decision_warning = warning;
    }
    return enriched;
  }

  function handleDecisionFailure({ err, args, title, content, classification, onInjection }) {
    const message = err instanceof DecisionError ? err.message : `Decision service error: ${err.message}`;

    // Disabled decision service — fall through to the legacy save with a
    // Warning so the user isn't silently locked out when their classifier
    // Daemon is down or intentionally turned off.
    if (err && err.code === 'disabled') {
      return runSave({
        args,
        title,
        content,
        classification: null,
        confidence: null,
        warning: message,
      });
    }

    // Guard failed and the caller wants hard refusal — surface it.
    if (classification === 'guard' && onInjection === 'refuse') {
      return deps.jsonErrNoExit(
        `Refusing to save: ${message}. Pass --on-injection save_as_security_block to capture the attempt as a bugfix.`,
      );
    }

    // Guard failed but caller wants to capture it as a security block.
    if (classification === 'guard' && onInjection === 'save_as_security_block') {
      return runSave({
        args,
        title,
        content,
        classification: { classification: 'guard', tool: null, confidence: 0, error: message },
        confidence: 0,
        override: { type: 'bugfix', 'topic-key': 'security-blocks' },
      });
    }

    // Moderate failed — capture as moderation-blocks for later review.
    if (classification === 'moderate') {
      return runSave({
        args,
        title,
        content,
        classification: { classification: 'moderate', tool: null, confidence: 0, error: message },
        confidence: 0,
        override: { type: 'bugfix', 'topic-key': 'moderation-blocks' },
      });
    }

    // Triage / email failures are non-security: save without classification
    // Metadata so the user's content is never lost.
    return runSave({
      args,
      title,
      content,
      classification: { classification, tool: null, confidence: 0, error: message },
      confidence: 0,
      warning: message,
    });
  }

  return async function saveClassified(args) {
    const { jsonErrNoExit } = deps,
      title = arg(args, 'title'),
      content = arg(args, 'content'),
      classificationRequested = arg(args, 'classification', 'classification') || 'auto',
      onInjection = arg(args, 'on-injection', 'on_injection') || 'refuse',
      baseTrustRaw = arg(args, 'trust-score', 'trust_score');

    if (!title || !content) {
      return jsonErrNoExit('save-classified requires --title and --content');
    }

    // Step 1: resolve which classifier to run.
    let chosen = classificationRequested,
      autoReason = null;
    if (chosen === 'auto') {
      const auto = autoClassify(content);
      if (!auto) {
        // No heuristic match — fall through to the legacy save with no
        // Classification metadata; downstream tooling can re-classify
        // Later.  Don't fail just because auto couldn't pick.
        return runSave({
          args,
          title,
          content,
          classification: null,
          confidence: null,
          warning: 'autoClassify returned null — saved without classification',
        });
      }
      chosen = auto.classification;
      autoReason = auto.reason;
    }

    // Step 2: call the chosen classifier.
    let classified;
    try {
      classified = await classifyContent(content, chosen);
    } catch (err) {
      return handleDecisionFailure({
        err,
        args,
        title,
        content,
        classification: chosen,
        onInjection,
      });
    }

    // Step 3: act on the classification.
    const guardFlagged =
      chosen === 'guard' &&
      classified.result &&
      (classified.result.is_injection === true || classified.result.injection === true);
    if (guardFlagged) {
      if (onInjection === 'save_as_security_block') {
        return runSave({
          args,
          title,
          content,
          classification: classified,
          confidence: classified.confidence,
          override: { type: 'bugfix', 'topic-key': 'security-blocks' },
        });
      }
      return jsonErrNoExit(
        `Refusing to save: prompt injection detected by ${classified.tool} ` +
          `(confidence: ${(classified.confidence * 100).toFixed(0)}%). ` +
          `Pass --on-injection save_as_security_block to capture the attempt as a bugfix.`,
      );
    }

    // Step 4: success — compute adjusted args + trust score, then save.
    const baseTrust = baseTrustRaw !== undefined ? Number(baseTrustRaw) : 1.0,
      adjustedTrust = Number.isFinite(baseTrust)
        ? Math.max(0, Math.min(1, baseTrust * classified.confidence))
        : classified.confidence,
      override = { 'trust-score': String(adjustedTrust) };
    return runSave({
      args,
      title,
      content,
      classification: { ...classified, auto_reason: autoReason },
      confidence: classified.confidence,
      override,
    });
  };
}

function register(commands, deps) {
  const { sqlJson, sqlRun, sqlRaw, jsonErrNoExit, repositories } = deps,
    memoryRepository = repositories && repositories.memory;

  commands.save = (args) =>
    require('../../../commands/observation').save({ sqlJson, sqlRun, sqlRaw, jsonErrNoExit, memoryRepository }, args);
  commands['save-classified'] = buildSaveClassified(deps, commands);
  // Slice A (judgment): advisory Decision rerank of the ranked results — opt-in.
  // Default config (provider=heuristic / no LIQUID_API_KEY) returns the sync
  // result unchanged: no awaits on the judgment path, no new fields. Any
  // judgment failure degrades to the lexical order. The gateway dispatch()
  // awaits command results, so an async wrapper here is safe.
  commands.search = async (args) => {
    const result = searchCmd.search(
      {
        sqlJson,
        sqlRun,
        jsonErrNoExit,
        searchCode: (q, repo, kind, limit) => require('../../../services/code-search').searchCode(q, repo, kind, limit),
      },
      args,
    );
    try {
      const { searchDecisionEnabled, decisionRerank } = require('../../memory-domain/search-decision');
      if (searchDecisionEnabled() && result && Array.isArray(result.results) && result.results.length > 0) {
        const rerank = await decisionRerank(result.results, args.query, args);
        if (rerank && rerank.reranked) result.results = rerank.rows;
      }
    } catch {
      // advisory only — lexical result unchanged
    }
    return result;
  };
  // Slice G (judgment): advisory Decision selection of the context candidates —
  // opt-in. Default config (provider=heuristic / no LIQUID_API_KEY) returns
  // the sync result unchanged: no new fields, no selection change. Any
  // judgment failure degrades to the builder's own ordering. The gateway
  // dispatch() awaits command results, so an async wrapper here is safe.
  // The sync core context builder (src/memory-domain/context.js) is untouched.
  commands.context = async (args) => {
    const result = searchCmd.context(
      {
        sqlJson,
        sqlRun,
        jsonErrNoExit,
        searchCode: (q, repo, kind, limit) => require('../../../services/code-search').searchCode(q, repo, kind, limit),
      },
      args,
    );
    try {
      const { contextDecisionEnabled, maybeContextDecisionSelection } = require('../../memory-domain/context-decision');
      // Skipped without a query/topic (nothing to judge relevance against) and
      // when the caller judges the candidates itself ('decision-select': 'off'
      // — the Claude Code prompt hook, which filters every injected section
      // in one request).
      const task = args.query || args['topic-key'];
      if (
        task &&
        args['decision-select'] !== 'off' &&
        contextDecisionEnabled() &&
        result &&
        Array.isArray(result.observations) &&
        result.observations.length > 0
      ) {
        const sel = await maybeContextDecisionSelection(result.observations, task, null, args);
        if (sel && !sel.unavailable && Array.isArray(sel.selected)) {
          result.observations = sel.selected;
          result.decisionSelected = true; // advisory marker — all other result fields kept
        }
      }
    } catch {
      // advisory only — builder's selection unchanged
    }
    return result;
  };
  commands.get = (args) =>
    require('../../../commands/observation').get({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.update = (args) =>
    require('../../../commands/observation').update({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.delete = (args) =>
    require('../../../commands/observation').del({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.timeline = (args) =>
    require('../../../commands/observation').timeline({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['suggest-topic-key'] = (args) => require('../../../commands/observation').suggestTopicKey(args);
  commands['save-prompt'] = (args) =>
    require('../../../commands/observation').savePrompt({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['capture-passive'] = (args) =>
    require('../../../commands/observation').capturePassive({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['log-negative-recall'] = (args) =>
    require('../../../commands/observation').logNegativeRecall(
      { sqlJson, sqlRun, jsonErrNoExit, memoryRepository },
      args,
    );
  commands.stats = () => require('../../../commands/observation').getStats({ ...deps, memoryRepository });
  commands['check-dup'] = (args) => searchCmd.checkDuplicate({ sqlJson, jsonErrNoExit }, args);
  commands['mark-dup'] = (args) => searchCmd.markDuplicate({ sqlJson, sqlRun, jsonErrNoExit }, args);
}

module.exports = { register, USAGE, buildSaveClassified };
