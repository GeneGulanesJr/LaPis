const codeAnalysis = require('../src/code-analysis');
const graph = require('../src/code-analysis/graph');
const quality = require('../src/code-analysis/quality');
const { CodeIndexReadRepository } = require('../src/code-analysis/read-model');
const { runAnalyzer } = require('../src/code-analysis/analyzer-runner');

function throwingDb(message = 'boom') {
  return {
    prepare() {
      throw new Error(message);
    },
  };
}

describe('code-analysis analyzer modules', () => {
  it('keeps the root code-analysis facade backward compatible', () => {
    expect(codeAnalysis.getImportGraph).toBe(graph.getImportGraph);
    expect(codeAnalysis.getComplexity).toBe(quality.getComplexity);
    expect(typeof codeAnalysis.getPrRiskProfile).toBe('function');
    expect(typeof codeAnalysis.scanAstPatterns).toBe('function');
  });

  it('returns scoped analyzer errors instead of throwing', () => {
    const result = quality.getComplexity(throwingDb('complexity failed'), 1);
    expect(result).toEqual({
      error: 'complexity failed',
      analyzer: 'complexity',
      scoped: true,
    });
  });

  it('runAnalyzer scopes failures to the requested analyzer', () => {
    const result = runAnalyzer('unit-analyzer', () => {
      throw new Error('unit failure');
    });
    expect(result.error).toBe('unit failure');
    expect(result.analyzer).toBe('unit-analyzer');
    expect(result.scoped).toBe(true);
  });

  it('CodeIndexReadRepository reports native db guard errors for fallback handles', () => {
    const repo = new CodeIndexReadRepository(null),
      result = repo.guard();
    expect(result.error).toContain('native SQLite backend');
  });
});
