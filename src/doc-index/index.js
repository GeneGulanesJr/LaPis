const { withDb } = require('../../utils');
const repos = require('./repos');
const markdownParser = require('./markdown-parser');
const sections = require('./sections');
const links = require('./links');
const glossary = require('./glossary');
const examples = require('./examples');
const analytics = require('./analytics');

module.exports = {
  indexDocs: withDb(repos.indexDocs),
  reindexDocs: withDb(repos.reindexDocs),
  searchDocs: withDb(analytics.searchDocs),
  getDocOutline: withDb(sections.getDocOutline),
  getBacklinks: withDb(links.getBacklinks),
  getBrokenLinks: withDb(links.getBrokenLinks),
  lookupTerm: withDb(glossary.lookupTerm),
  getTutorialPath: withDb(analytics.getTutorialPath),
  findCodeExamples: withDb(examples.findCodeExamples),
  resolveLinks: withDb(links.resolveLinks),
  getOrphanSections: withDb(analytics.getOrphanSections),
  getDocCoverage: withDb(analytics.getDocCoverage),
  getStalePages: withDb(analytics.getStalePages),
  getDuplicateSections: withDb(analytics.getDuplicateSections),
  _parseMarkdownSections: markdownParser.parseMarkdownSections,
  _slugify: markdownParser.slugify,
  _extractLinks: links.extractLinks,
  _extractGlossaryTerms: glossary.extractGlossaryTerms,
  _extractCodeBlocks: examples.extractCodeBlocks,
  _getDocCoverageReport: analytics.getDocCoverageReport,
  _modules: { repos, markdownParser, sections, links, glossary, examples, analytics },
};
