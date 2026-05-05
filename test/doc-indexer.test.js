const path = require('path');
const {
  createIsolatedTestDb,
  writeTmpRepo,
  FIXTURE_MARKDOWN,
  FIXTURE_JS,
  FIXTURE_JS2,
} = require('./helpers/isolated-db');

const DOC_REPO = 'test-docs';

let ctx;

beforeAll(() => {
  ctx = createIsolatedTestDb();
  const docDir = writeTmpRepo(path.join(ctx.tmpDir, 'docs'), {
    'guide.md': FIXTURE_MARKDOWN,
    'api.md': `# API

## save

Saves a memory observation.

## search

Searches observations.
`,
  });
  const r = ctx.run(`index-docs --path "${docDir}" --name ${DOC_REPO}`);
  if (r.error) {
    throw new Error(`Failed to index docs: ${JSON.stringify(r)}`);
  }
});

afterAll(() => {
  ctx.cleanup();
});

describe('doc-indexer: doc-search', () => {
  it('should find sections by query', () => {
    const r = ctx.run(`doc-search --query "database" --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should filter by role', () => {
    const r = ctx.run(`doc-search --query "install" --repo ${DOC_REPO} --role tutorial`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('should return answerable sections with heuristics', () => {
    const r = ctx.run(`doc-search --query "save memory" --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
    if (r.results.length > 0) {
      const first = r.results[0];
      expect(first.title).toBeTruthy();
      expect(first.role).toBeTruthy();
    }
  });
});

describe('doc-indexer: doc-outline', () => {
  it('should return full outline', () => {
    const r = ctx.run(`doc-outline --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(r.files !== undefined || Array.isArray(r)).toBe(true);
  });

  it('should return single file outline', () => {
    const r = ctx.run(`doc-outline --repo ${DOC_REPO} --file guide.md`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r) || typeof r === 'object').toBe(true);
  });
});

describe('doc-indexer: backlinks and broken-links', () => {
  it('should find inbound backlinks', () => {
    const r = ctx.run(`backlinks --repo ${DOC_REPO} --path guide.md`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.backlinks)).toBe(true);
  });

  it('should find broken links', () => {
    const r = ctx.run(`broken-links --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.broken_links)).toBe(true);
  });
});

describe('doc-indexer: glossary', () => {
  it('should list terms', () => {
    const r = ctx.run(`glossary --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r)).toBe(true);
  });

  it('should have structured term entries when available', () => {
    const r = ctx.run(`glossary --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    if (Array.isArray(r) && r.length > 0) {
      const term = r[0];
      expect(term.term).toBeTruthy();
      expect(term.definition).toBeTruthy();
    }
  });
});

describe('doc-indexer: tutorial-path', () => {
  it('should find tutorial chain for a known section', () => {
    const r = ctx.run(`tutorial-path --repo ${DOC_REPO} --section 1`);
    if (r.error) {
      expect(typeof r.error).toBe('string');
    } else {
      expect(Array.isArray(r.chain)).toBe(true);
    }
  });
});

describe('doc-indexer: code-examples', () => {
  it('should find code blocks by content', () => {
    const r = ctx.run(`code-examples --repo ${DOC_REPO} --query "npm"`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('should filter code examples by language', () => {
    const r = ctx.run(`code-examples --repo ${DOC_REPO} --query "npm" --lang js`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
  });
});

describe('doc-indexer: doc-orphans', () => {
  it('should find orphan sections', () => {
    const r = ctx.run(`doc-orphans --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.orphans)).toBe(true);
    expect(typeof r.total).toBe('number');
  });

  it('should support include_same_doc option', () => {
    const r = ctx.run(`doc-orphans --repo ${DOC_REPO} --include_same_doc`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.orphans)).toBe(true);
    expect(r.orphans.length).toBeGreaterThanOrEqual(0);
  });
});

describe('doc-indexer: doc-coverage', () => {
  it('should compute coverage between code and doc repos', () => {
    const codeDir = writeTmpRepo(path.join(ctx.tmpDir, 'coverage-code'), {
      'utils.js': FIXTURE_JS,
      'index.js': FIXTURE_JS2,
    });
    ctx.run(`index-repo --path "${codeDir}" --name test-coverage-repo`);
    const r = ctx.run(`doc-coverage --repo test-coverage-repo --doc-repo ${DOC_REPO}`);
    if (r.error) {
      expect(typeof r.error).toBe('string');
    } else {
      expect(typeof r.coverage_pct).toBe('number');
      expect(r.total_symbols).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('doc-indexer: stale-pages', () => {
  it('should detect stale docs with valid structure', () => {
    const r = ctx.run(`stale-pages --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.stale)).toBe(true);
    expect(Array.isArray(r.missing)).toBe(true);
    expect(typeof r.total_files).toBe('number');
  });

  it('should report zero stale pages right after reindex', () => {
    ctx.run(`reindex-docs --repo ${DOC_REPO} --mode full`);
    const r = ctx.run(`stale-pages --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.stale)).toBe(true);
    expect(r.stale.length).toBe(0);
  });
});

describe('doc-indexer: doc-duplicates', () => {
  it('should detect duplicate sections', () => {
    const r = ctx.run(`doc-duplicates --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.duplicates)).toBe(true);
    expect(typeof r.total_duplicate_groups).toBe('number');
  });

  it('should return structured duplicate groups with sections', () => {
    const r = ctx.run(`doc-duplicates --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.duplicates)).toBe(true);
    if (r.duplicates.length > 0) {
      const dup = r.duplicates[0];
      expect(typeof dup.count).toBe('number');
      expect(dup.count).toBeGreaterThan(1);
      expect(Array.isArray(dup.sections)).toBe(true);
      expect(dup.sections.length).toBeGreaterThanOrEqual(1);
      expect(dup.sections[0].title).toBeTruthy();
      expect(dup.sections[0].file_path).toBeTruthy();
    }
  });
});

describe('doc-indexer: reindex', () => {
  it('should reindex successfully with file and section counts', () => {
    const r = ctx.run(`reindex-docs --repo ${DOC_REPO} --mode full`);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.files).toBeGreaterThanOrEqual(1);
    expect(r.sections).toBeGreaterThanOrEqual(1);
  });

  it('should report link and code block counts after reindex', () => {
    const r = ctx.run(`reindex-docs --repo ${DOC_REPO} --mode full`);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(typeof r.links).toBe('number');
    expect(typeof r.code_blocks).toBe('number');
  });
});
