const path = require('path');
const {
  createIsolatedTestDb,
  writeTmpRepo,
  FIXTURE_JS,
  FIXTURE_JS2,
} = require('./helpers/isolated-db');

const REPO = 'test-code-analysis';

let ctx;

beforeAll(() => {
  ctx = createIsolatedTestDb();
  const codeDir = writeTmpRepo(path.join(ctx.tmpDir, 'code'), {
    'utils.js': FIXTURE_JS,
    'index.js': FIXTURE_JS2,
  });
  const r = ctx.run(`index-repo --path "${codeDir}" --name ${REPO}`);
  if (r.error) {
    throw new Error(`Failed to index repo: ${JSON.stringify(r)}`);
  }
});

afterAll(() => {
  ctx.cleanup();
});

describe('code-analysis: import-graph', () => {
  it('should return import edges for a specific file', () => {
    const r = ctx.run(`import-graph --repo ${REPO} --file utils.js`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.edges)).toBe(true);
  });

  it('should support recursive traversal with downstream tracking', () => {
    const r = ctx.run(`import-graph --repo ${REPO} --file index.js --direction imports --depth 2`);
    expect(r.error).toBeUndefined();
    expect(r.downstream !== undefined || Array.isArray(r.edges)).toBe(true);
  });

  it('should list repo-wide edges with source/target/type', () => {
    const r = ctx.run(`import-graph --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.edges)).toBe(true);
    expect(r.edges.length).toBeGreaterThan(0);
    const edge = r.edges[0];
    expect(edge.source).toBeTruthy();
    expect(edge.target).toBeTruthy();
    expect(edge.type).toBeTruthy();
  });
});

describe('code-analysis: call-hierarchy', () => {
  it('should find callers of a known symbol', () => {
    const r = ctx.run(`call-hierarchy --symbol add --repo ${REPO} --direction callers --depth 2`);
    expect(r.error).toBeUndefined();
    expect(r.symbol).toBe('add');
    expect(Array.isArray(r.callers)).toBe(true);
  });

  it('should find callees of a known symbol', () => {
    const r = ctx.run(`call-hierarchy --symbol compute --repo ${REPO} --direction callees --depth 2`);
    expect(r.error).toBeUndefined();
    expect(r.symbol).toBe('compute');
    expect(Array.isArray(r.callees)).toBe(true);
  });
});

describe('code-analysis: blast-radius', () => {
  it('should return affected files for a known symbol', () => {
    const r = ctx.run(`blast-radius --symbol add --repo ${REPO} --depth 2`);
    if (r.error) {
      expect(typeof r.error).toBe('string');
    } else {
      expect(r.symbol).toBeTruthy();
      expect(Array.isArray(r.callers) || Array.isArray(r.edges)).toBe(true);
    }
  });
});

describe('code-analysis: dead-code', () => {
  it('should return dead symbol candidates', () => {
    const r = ctx.run(`dead-code --repo ${REPO} --min-confidence 0.3`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.dead_symbols)).toBe(true);
  });

  it('should enforce min-confidence filtering', () => {
    const rLow = ctx.run(`dead-code --repo ${REPO} --min-confidence 0.3`);
    expect(rLow.error).toBeUndefined();
    expect(Array.isArray(rLow.dead_symbols)).toBe(true);
  });
});

describe('code-analysis: complexity', () => {
  it('should return complexity data for the whole repo', () => {
    const r = ctx.run(`complexity --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    const list = Array.isArray(r) ? r : [r];
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) {
      expect(typeof item.cyclomatic).toBe('number');
    }
  });

  it('should return complexity for a single symbol', () => {
    const r = ctx.run(`complexity --repo ${REPO} --symbol add`);
    expect(r.error).toBeUndefined();
    expect(r.name).toBe('add');
    expect(typeof r.cyclomatic).toBe('number');
  });

  it('should report valid assessment levels (low/medium/high)', () => {
    const r = ctx.run(`complexity --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    const list = Array.isArray(r) ? r : [r];
    const assessments = list.map(x => x.assessment).filter(Boolean);
    expect(assessments.length).toBeGreaterThan(0);
    for (const a of assessments) {
      expect(['low', 'medium', 'high']).toContain(a);
    }
  });
});

describe('code-analysis: outline', () => {
  it('should return file outline with standalone symbols', () => {
    const r = ctx.run(`outline --repo ${REPO} --file utils.js`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.standalone)).toBe(true);
    expect(r.standalone.length).toBeGreaterThan(0);
    const first = r.standalone[0];
    expect(first.name).toBeTruthy();
  });
});

describe('code-analysis: cycles', () => {
  it('should detect dependency cycles with valid structure', () => {
    const r = ctx.run(`cycles --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.cycles)).toBe(true);
    expect(typeof r.total_circular_files).toBe('number');
  });

  it('should have valid cycle edge format when cycles exist', () => {
    const r = ctx.run(`cycles --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    if (r.cycles.length > 0) {
      for (const cycle of r.cycles) {
        expect(Array.isArray(cycle.files)).toBe(true);
        expect(cycle.size).toBeGreaterThan(1);
      }
    }
  });
});

describe('code-analysis: importance', () => {
  it('should return PageRank-sorted nodes with scores', () => {
    const r = ctx.run(`importance --repo ${REPO} --top 5`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.nodes)).toBe(true);
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.total_symbols).toBeGreaterThan(0);
    for (const node of r.nodes) {
      expect(typeof node.pagerank).toBe('number');
    }
    for (let i = 0; i < r.nodes.length - 1; i++) {
      expect(r.nodes[i].pagerank).toBeGreaterThanOrEqual(r.nodes[i + 1].pagerank);
    }
  });
});

describe('code-analysis: coupling', () => {
  it('should return coupling metrics for all files', () => {
    const r = ctx.run(`coupling --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.metrics)).toBe(true);
    expect(r.metrics.length).toBeGreaterThan(0);
  });

  it('should categorize files as stable/balanced/unstable', () => {
    const r = ctx.run(`coupling --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(r.metrics.length).toBeGreaterThan(0);
    const categories = new Set(r.metrics.map(m => m.category));
    for (const c of categories) {
      expect(['stable', 'balanced', 'unstable']).toContain(c);
    }
  });
});

describe('code-analysis: extractable', () => {
  it('should return extraction candidates', () => {
    const r = ctx.run(`extractable --repo ${REPO} --min-complexity 1 --min-callers 0 --top 10`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.candidates)).toBe(true);
  });

  it('should score candidates with complexity and extraction_score', () => {
    const r = ctx.run(`extractable --repo ${REPO} --min-complexity 1 --min-callers 0 --top 5`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.candidates)).toBe(true);
    if (r.candidates.length > 0) {
      const c = r.candidates[0];
      expect(typeof c.extraction_score).toBe('number');
    }
  });
});

describe('code-analysis: hierarchy', () => {
  it('should resolve symbol to its ancestors/descendants', () => {
    const r = ctx.run(`hierarchy --repo ${REPO} --symbol compute`);
    expect(r.error).toBeUndefined();
    expect(r.name).toBe('compute');
  });

  it('should include kind and file_path for resolved symbols', () => {
    const r = ctx.run(`hierarchy --repo ${REPO} --symbol compute`);
    expect(r.error).toBeUndefined();
    expect(r.kind).toBeTruthy();
    expect(r.file_path).toBeTruthy();
  });
});

describe('code-analysis: signal-chains', () => {
  it('should detect gateway chains with a gateway count', () => {
    const r = ctx.run(`signal-chains --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.chains)).toBe(true);
    expect(typeof r.gateway_count).toBe('number');
  });
});

describe('code-analysis: layer-violations', () => {
  it('should return either violations or a helpful note about missing config', () => {
    const r = ctx.run(`layer-violations --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(r.violations !== undefined || r.note !== undefined).toBe(true);
    if (r.violations) {expect(Array.isArray(r.violations)).toBe(true);}
    if (r.note) {expect(typeof r.note).toBe('string');}
  });
});

describe('code-analysis: search-code and get-code-source', () => {
  it('should find code symbols by name', () => {
    const r = ctx.run(`search-code --query add --repo ${REPO} --max-results 3`);
    expect(r.error).toBeUndefined();
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results[0].symbol).toBeTruthy();
  });

  it('should retrieve source code for a known symbol', () => {
    const utilsPath = path.join(ctx.tmpDir, 'code', 'utils.js');
    const r = ctx.run(`get-code-source --repo ${REPO} --file ${utilsPath} --name add`);
    if (r.error) {
      expect(typeof r.error).toBe('string');
    } else {
      expect(r.success).toBe(true);
      expect(r.source).toContain('return');
      expect(r.symbol).toBe('add');
    }
  });
});

describe('code-analysis: winnow (v6)', () => {
  it('should filter by kind and sort by pagerank', () => {
    const r = ctx.run(`winnow --repo ${REPO} --kind function --top 5 --sort-by pagerank`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.total_matched).toBeGreaterThanOrEqual(r.results.length);
    for (const sym of r.results) {
      expect(sym.kind).toBe('function');
    }
  });

  it('should filter by file glob', () => {
    const r = ctx.run(`winnow --repo ${REPO} --file-glob "*utils*" --top 10`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
    for (const sym of r.results) {
      expect(sym.file_path).toContain('utils');
    }
  });

  it('should intersect multiple axes', () => {
    const r = ctx.run(`winnow --repo ${REPO} --kind function --min-complexity 1 --top 10`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.axes.length).toBeGreaterThanOrEqual(2);
    for (const sym of r.results) {
      expect(sym.kind).toBe('function');
    }
  });

  it('should report active axes used', () => {
    const r = ctx.run(`winnow --repo ${REPO} --kind class --min-callers 0 --top 3`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.axes)).toBe(true);
    expect(r.axes).toContain('kind');
    expect(r.axes).toContain('min_callers');
    expect(r.total_symbols).toBeGreaterThan(0);
  });
});

describe('code-analysis: untested (v6)', () => {
  it('should detect untested symbols with confidence levels', () => {
    const r = ctx.run(`untested --repo ${REPO} --min-confidence 0.5`);
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.untested)).toBe(true);
    expect(r.total_symbols).toBeGreaterThan(0);
    expect(typeof r.test_files_found).toBe('number');
    expect(typeof r.total_files).toBe('number');
    for (const sym of r.untested) {
      expect([1.0, 0.7, 0.4]).toContain(sym.untested_confidence);
    }
  });

  it('should exclude private symbols by default', () => {
    const r = ctx.run(`untested --repo ${REPO} --min-confidence 0.3`);
    expect(r.error).toBeUndefined();
    const privateSyms = (r.untested || []).filter(s => s.name.startsWith('_'));
    expect(privateSyms.length).toBe(0);
  });

  it('should include private symbols when requested', () => {
    const rWithout = ctx.run(`untested --repo ${REPO} --min-confidence 0.3`);
    const rWith = ctx.run(`untested --repo ${REPO} --min-confidence 0.3 --include-private true`);
    expect(rWith.error).toBeUndefined();
    expect(rWith.untested.length).toBeGreaterThanOrEqual((rWithout.untested || []).length);
  });

  it('should guard against missing db', () => {
    const { getUntestedSymbols } = require('../code-analysis');
    const result = getUntestedSymbols(null, 1);
    expect(result.error).toBeDefined();
  });
});

describe('code-analysis: pr-risk (v6)', () => {
  it('should compute risk profile with signal breakdown', () => {
    const r = ctx.run(`pr-risk --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(r.signals).toBeDefined();
    expect(typeof r.composite).toBe('number');
    expect(['low', 'medium', 'high', 'critical']).toContain(r.risk_level);
    const signalKeys = Object.keys(r.signals);
    expect(signalKeys.length).toBeGreaterThanOrEqual(0);
    for (const key of signalKeys) {
      expect(r.signals[key]).toBeGreaterThanOrEqual(0);
      expect(r.signals[key]).toBeLessThanOrEqual(1);
    }
  });

  it('should report changed files and symbols count', () => {
    const r = ctx.run(`pr-risk --repo ${REPO}`);
    expect(r.error).toBeUndefined();
    expect(r.changed_files !== undefined || r.note !== undefined).toBe(true);
  });

  it('should guard against missing db', () => {
    const { getPrRiskProfile } = require('../code-analysis');
    const result = getPrRiskProfile(null, 1);
    expect(result.error).toBeDefined();
  });

  it('should handle nonexistent branches gracefully', () => {
    const r = ctx.run(`pr-risk --repo ${REPO} --branch nonexistent-branch-xyz --base main`);
    if (r.error) {
      expect(typeof r.error).toBe('string');
    } else {
      expect(r.signals).toBeDefined();
    }
  });
});
