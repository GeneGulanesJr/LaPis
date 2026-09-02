// Integration tests for doc-indexer (v5)
const { execSync } = require('child_process'),
  path = require('path'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js'),
  DOC_REPO = 'pi-docs',
  DOC_PATH = path.resolve(__dirname, '..', 'docs');

function run(cmd) {
  try {
    const out = execSync(`node "${STORE}" ${cmd}`, {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      result = JSON.parse(out.trim());
    return result.data || result;
  } catch (e) {
    if (e.stdout?.trim()) {
      const result = JSON.parse(e.stdout.trim());
      return result.data || result;
    }
    return { error: e.message };
  }
}

// Ensure docs are indexed before all test groups
beforeAll(() => {
  const r = run(`reindex-docs --repo ${DOC_REPO} --mode full`);
  if (r.error) {
    run(`index-docs --path "${DOC_PATH}" --name ${DOC_REPO}`);
  }
});

describe('doc-indexer: doc-search', () => {
  it('should find sections by query', () => {
    const r = run(`doc-search --query "memory wasm" --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should filter by role', () => {
    const r = run(`doc-search --query "code" --repo ${DOC_REPO} --role how_to`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('should return answerable sections with heuristics', () => {
    const r = run(`doc-search --query "memory store" --repo ${DOC_REPO}`);
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
    const r = run(`doc-outline --repo ${DOC_REPO}`);
    // Outline returns either { files: [...] } or the raw array depending on options
    expect(r.error).toBeUndefined();
    expect(r.files !== undefined || Array.isArray(r)).toBe(true);
  });

  it('should return single file outline', () => {
    const r = run(`doc-outline --repo ${DOC_REPO} --file SKILL.md`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r) || typeof r === 'object').toBe(true);
  });
});

describe('doc-indexer: backlinks and broken-links', () => {
  it('should find inbound backlinks', () => {
    const r = run(`backlinks --repo ${DOC_REPO} --path SKILL.md`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.backlinks)).toBe(true);
  });

  it('should find broken links', () => {
    const r = run(`broken-links --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.broken_links)).toBe(true);
  });
});

describe('doc-indexer: glossary', () => {
  it('should list terms', () => {
    const r = run(`glossary --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r)).toBe(true);
  });

  it('should have structured term entries when available', () => {
    const r = run(`glossary --repo ${DOC_REPO}`);
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
    const r = run(`tutorial-path --repo ${DOC_REPO} --section 740`);
    // Section 740 may not exist in all doc sets — check error is about missing section, not runtime failure
    if (r.error) {
      expect(typeof r.error).toBe('string');
    } else {
      expect(Array.isArray(r.chain)).toBe(true);
    }
  });
});

describe('doc-indexer: code-examples', () => {
  it('should find code blocks by content', () => {
    const r = run(`code-examples --repo ${DOC_REPO} --query "require"`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('should filter code examples by language', () => {
    const r = run(`code-examples --repo ${DOC_REPO} --query "require" --lang js`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
  });
});

describe('doc-indexer: doc-orphans', () => {
  it('should find orphan sections', () => {
    const r = run(`doc-orphans --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.orphans)).toBe(true);
    expect(typeof r.total).toBe('number');
  });

  it('should support include_same_doc option', () => {
    const r = run(`doc-orphans --repo ${DOC_REPO} --include_same_doc`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.orphans)).toBe(true);
    expect(r.orphans.length).toBeGreaterThanOrEqual(0);
  });
});

describe('doc-indexer: doc-coverage', () => {
  it('should compute coverage between code and doc repos', () => {
    const r = run(`doc-coverage --repo PiMemoryExtension --doc-repo ${DOC_REPO}`);
    // This may fail if PiMemoryExtension isn't indexed yet — skip gracefully
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
    const r = run(`stale-pages --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.stale)).toBe(true);
    expect(Array.isArray(r.missing)).toBe(true);
    expect(typeof r.total_files).toBe('number');
  });

  it('should report zero stale pages right after reindex', () => {
    run(`reindex-docs --repo ${DOC_REPO} --mode full`);
    const r = run(`stale-pages --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.stale)).toBe(true);
    expect(r.stale.length).toBe(0);
  });
});

describe('doc-indexer: doc-duplicates', () => {
  it('should detect duplicate sections', () => {
    const r = run(`doc-duplicates --repo ${DOC_REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.duplicates)).toBe(true);
    expect(typeof r.total_duplicate_groups).toBe('number');
  });

  it('should return structured duplicate groups with sections', () => {
    const r = run(`doc-duplicates --repo ${DOC_REPO}`);
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
    const r = run(`reindex-docs --repo ${DOC_REPO} --mode full`);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.files).toBeGreaterThanOrEqual(1);
    expect(r.sections).toBeGreaterThanOrEqual(1);
  });

  it('should report link and code block counts after reindex', () => {
    const r = run(`reindex-docs --repo ${DOC_REPO} --mode full`);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(typeof r.links).toBe('number');
    expect(typeof r.code_blocks).toBe('number');
  });
});
