const obsCmd = require('../../../commands/observation'),
  searchCmd = require('../../../commands/search'),
  codeSearchService = require('../../../services/code-search'),
  { classify: layaClassify, autoClassify: layaAutoClassify, LayaMCPError } = require('../../memory-domain/laya-mcp'),
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
      enriched.laya_warning = warning;
    }
    return enriched;
  }

  function handleLayaFailure({ err, args, title, content, classification, onInjection }) {
    const message = err instanceof LayaMCPError ? err.message : `LayaMCP error: ${err.message}`;

    // Disabled LayaMCP — fall through to the legacy save with a warning so
    // The user isn't silently locked out when their classifier daemon is
    // Down or intentionally turned off.
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
      const auto = layaAutoClassify(content);
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
    let layaResult;
    try {
      layaResult = await layaClassify(content, chosen);
    } catch (err) {
      return handleLayaFailure({
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
      layaResult.result &&
      (layaResult.result.is_injection === true || layaResult.result.injection === true);
    if (guardFlagged) {
      if (onInjection === 'save_as_security_block') {
        return runSave({
          args,
          title,
          content,
          classification: layaResult,
          confidence: layaResult.confidence,
          override: { type: 'bugfix', 'topic-key': 'security-blocks' },
        });
      }
      return jsonErrNoExit(
        `Refusing to save: prompt injection detected by ${layaResult.tool} ` +
          `(confidence: ${(layaResult.confidence * 100).toFixed(0)}%). ` +
          `Pass --on-injection save_as_security_block to capture the attempt as a bugfix.`,
      );
    }

    // Step 4: success — compute adjusted args + trust score, then save.
    const baseTrust = baseTrustRaw !== undefined ? Number(baseTrustRaw) : 1.0,
      adjustedTrust = Number.isFinite(baseTrust)
        ? Math.max(0, Math.min(1, baseTrust * layaResult.confidence))
        : layaResult.confidence,
      override = { 'trust-score': String(adjustedTrust) };
    return runSave({
      args,
      title,
      content,
      classification: { ...layaResult, auto_reason: autoReason },
      confidence: layaResult.confidence,
      override,
    });
  };
}

function register(commands, deps) {
  const { sqlJson, sqlRun, sqlRaw, jsonErrNoExit, repositories } = deps,
    memoryRepository = repositories && repositories.memory;

  commands.save = (args) => obsCmd.save({ sqlJson, sqlRun, sqlRaw, jsonErrNoExit, memoryRepository }, args);
  commands['save-classified'] = buildSaveClassified(deps, commands);
  commands.search = (args) =>
    searchCmd.search(
      {
        sqlJson,
        sqlRun,
        jsonErrNoExit,
        searchCode: (q, repo, kind, limit) => codeSearchService.searchCode(q, repo, kind, limit),
      },
      args,
    );
  commands.context = (args) =>
    searchCmd.context(
      {
        sqlJson,
        sqlRun,
        jsonErrNoExit,
        searchCode: (q, repo, kind, limit) => codeSearchService.searchCode(q, repo, kind, limit),
      },
      args,
    );
  commands.get = (args) => obsCmd.get({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.update = (args) => obsCmd.update({ sqlJson, sqlRun, sqlRaw, jsonErrNoExit, memoryRepository }, args);
  commands.delete = (args) => obsCmd.del({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.timeline = (args) => obsCmd.timeline({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['suggest-topic-key'] = (args) => obsCmd.suggestTopicKey(args);
  commands['save-prompt'] = (args) => obsCmd.savePrompt({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['capture-passive'] = (args) =>
    obsCmd.capturePassive({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands['log-negative-recall'] = (args) =>
    obsCmd.logNegativeRecall({ sqlJson, sqlRun, jsonErrNoExit, memoryRepository }, args);
  commands.stats = () => obsCmd.getStats({ ...deps, memoryRepository });
  commands['check-dup'] = (args) => searchCmd.checkDuplicate({ sqlJson, jsonErrNoExit }, args);
  commands['mark-dup'] = (args) => searchCmd.markDuplicate({ sqlJson, sqlRun, jsonErrNoExit }, args);
}

module.exports = { register, USAGE, buildSaveClassified };
