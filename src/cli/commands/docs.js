const path = require('path');
const docIndexer = require('../../doc-index');

const USAGE = {
  'doc-orphans': '--repo X [--include-same-doc]',
  'stale-pages': '--repo X',
  'doc-duplicates': '--repo X',
  'reindex-docs': '--repo X [--mode full|incremental] [--ignore GLOB]',
  'doc-search': '--query Q --repo X [--level N] [--role TYPE]',
  'doc-outline': '--repo X [--file F]',
  backlinks: '--repo X --path F',
  'broken-links': '--repo X',
  glossary: '--repo X [--term T]',
  'tutorial-path': '--section S --repo X',
  'code-examples': '--query Q --repo X [--lang X]',
  'index-docs': '--path P --name X [--ignore GLOB]',
  'doc-coverage': '--repo X [--doc-repo X]',
  'list-doc-repos': '',
};

function _dispatchDoc(cmd, repoName, fn, deps) {
  if (!repoName) {
    return deps.jsonErrNoExit(`Missing --repo. Usage: ${cmd} ${USAGE[cmd] || ''}`);
  }
  const repoRow = deps.sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repoName]);
  if (!repoRow.length) {
    return deps.jsonErrNoExit(`Doc repo "${repoName}" not found. Run index-docs first.`);
  }
  return fn(repoRow[0]);
}

function register(commands, deps) {
  const { sqlJson, jsonErrNoExit, getDb } = deps;
  const dispatchDeps = { sqlJson, jsonErrNoExit };

  commands['doc-orphans'] = (args) =>
    _dispatchDoc(
      'doc-orphans',
      args.repo,
      (r) => docIndexer.getOrphanSections(getDb(), r.id, { includeSameDoc: args['include-same-doc'] === 'true' }),
      dispatchDeps,
    );
  commands['doc-coverage'] = (args) => {
    const codeRepo = args.repo;
    const docRepo = args['doc-repo'] || codeRepo;
    if (!codeRepo) {
      return jsonErrNoExit('Missing --repo');
    }
    const codeRepoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [codeRepo]);
    if (!codeRepoRow.length) {
      return jsonErrNoExit(`Code repo "${codeRepo}" not found. Run index-repo first.`);
    }
    const docRepoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [docRepo]);
    if (!docRepoRow.length) {
      return jsonErrNoExit(`Doc repo "${docRepo}" not found. Run index-docs first.`);
    }
    return docIndexer.getDocCoverage(getDb(), codeRepoRow[0].id, docRepoRow[0].id);
  };
  commands['stale-pages'] = (args) =>
    _dispatchDoc('stale-pages', args.repo, (r) => docIndexer.getStalePages(getDb(), r.id), dispatchDeps);
  commands['doc-duplicates'] = (args) =>
    _dispatchDoc('doc-duplicates', args.repo, (r) => docIndexer.getDuplicateSections(getDb(), r.id), dispatchDeps);
  commands['index-docs'] = async (args) => {
    const docPath = args.path;
    const name = args.name;
    if (!docPath || !name) {
      return jsonErrNoExit('Usage: index-docs --path P --name X [--ignore GLOB]');
    }
    return docIndexer.indexDocs(getDb(), path.resolve(docPath), name, args.ignore || null);
  };
  commands['list-doc-repos'] = () => {
    const rows = sqlJson('SELECT name, path, file_count, section_count, indexed_at, updated_at FROM doc_repos ORDER BY updated_at DESC');
    return { repos: rows, total: rows.length };
  };
  commands['reindex-docs'] = async (args) =>
    _dispatchDoc(
      'reindex-docs',
      args.repo,
      async (r) => docIndexer.reindexDocs(getDb(), r.id, args.mode || 'full', args.ignore || null),
      dispatchDeps,
    );
  commands['doc-search'] = (args) => {
    if (!args.query) {
      return jsonErrNoExit('Missing --query. Usage: doc-search --query Q --repo X');
    }
    return _dispatchDoc(
      'doc-search',
      args.repo,
      (r) =>
        docIndexer.searchDocs(getDb(), r.id, args.query, {
          level: args.level ? parseInt(args.level) : null,
          role: args.role || null,
        }),
      dispatchDeps,
    );
  };
  commands['doc-outline'] = (args) =>
    _dispatchDoc(
      'doc-outline',
      args.repo,
      (r) => docIndexer.getDocOutline(getDb(), r.id, args.file || null),
      dispatchDeps,
    );
  commands.backlinks = (args) => {
    if (!args.path) {
      return jsonErrNoExit('Missing --path. Usage: backlinks --repo X --path F');
    }
    return _dispatchDoc('backlinks', args.repo, (r) => docIndexer.getBacklinks(getDb(), r.id, args.path), dispatchDeps);
  };
  commands['broken-links'] = (args) =>
    _dispatchDoc(
      'broken-links',
      args.repo,
      (r) => ({ broken_links: docIndexer.getBrokenLinks(getDb(), r.id) }),
      dispatchDeps,
    );
  commands.glossary = (args) =>
    _dispatchDoc('glossary', args.repo, (r) => docIndexer.lookupTerm(getDb(), r.id, args.term || null), dispatchDeps);
  commands['tutorial-path'] = (args) => {
    if (!args.section) {
      return jsonErrNoExit('Missing --section. Usage: tutorial-path --section S --repo X');
    }
    return _dispatchDoc(
      'tutorial-path',
      args.repo,
      (r) => docIndexer.getTutorialPath(getDb(), r.id, parseInt(args.section)),
      dispatchDeps,
    );
  };
  commands['code-examples'] = (args) => {
    if (!args.query) {
      return jsonErrNoExit('Missing --query. Usage: code-examples --query Q --repo X');
    }
    return _dispatchDoc(
      'code-examples',
      args.repo,
      (r) => docIndexer.findCodeExamples(getDb(), r.id, args.query, args.lang || null),
      dispatchDeps,
    );
  };
}

module.exports = { register, USAGE };
