// Lazy requires for obsCmd/codeSearchService: the hook path dispatches
// `context` in a fresh process, and an eager top-level require made every
// memory-router command pay for the observation-CRUD and code-search subtrees
// (~16ms measured marginal) even when its own handler never touches them.
// commands/search stays eager — search and context both need it.
const searchCmd = require('../../../commands/search'),
  USAGE = {
    save: '--title <title> --content <content> [--type TYPE] [--project NAME] [--scope SCOPE] [--topic-key KEY] [--force] [--expires-in DUR] [--session-id ID]',
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

function register(commands, deps) {
  const { sqlJson, sqlRun, sqlRaw, jsonErrNoExit, repositories } = deps,
    memoryRepository = repositories && repositories.memory;

  commands.save = (args) =>
    require('../../../commands/observation').save({ sqlJson, sqlRun, sqlRaw, jsonErrNoExit, memoryRepository }, args);
  // Slice A (judgment): advisory Jev rerank of the ranked results — opt-in.
  // Default config (provider=heuristic / no TYPESAFE_API_KEY) returns the sync
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
      const { searchJevEnabled, jevRerank } = require('../../memory-domain/search-jev');
      if (searchJevEnabled() && result && Array.isArray(result.results) && result.results.length > 0) {
        const rerank = await jevRerank(result.results, args.query, args);
        if (rerank && rerank.reranked) result.results = rerank.rows;
      }
    } catch {
      // advisory only — lexical result unchanged
    }
    return result;
  };
  // Slice G (judgment): advisory Jev selection of the context candidates —
  // opt-in. Default config (provider=heuristic / no TYPESAFE_API_KEY) returns
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
      const { contextJevEnabled, maybeContextJevSelection } = require('../../memory-domain/context-jev');
      if (contextJevEnabled() && result && Array.isArray(result.observations) && result.observations.length > 0) {
        const sel = await maybeContextJevSelection(
          result.observations,
          args.query || args['topic-key'] || 'context-auto',
          null,
          args,
        );
        if (sel && !sel.unavailable && Array.isArray(sel.selected)) {
          result.observations = sel.selected;
          result.jevSelected = true; // advisory marker — all other result fields kept
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

module.exports = { register, USAGE };
