import { describe, expect, it } from 'vitest';

let parseCode;
async function getParser() {
  if (!parseCode) {
    parseCode = require('../parse-code');
    if (!parseCode.isReady()) {
      await parseCode.init();
    }
  }
  return parseCode;
}

describe('Dynamic callee extraction (via extractCalleesFromContent)', () => {
  it('captures dynamic import() paths', async () => {
    const parser = await getParser(),
      code = `const mod = import('./module.js');`,
      result = parser.extractCalleesFromContent('test.js', code),
      dynamicImports = result.filter((c) => c.callee === 'import' && c.module_path);
    expect(dynamicImports.length).toBeGreaterThanOrEqual(1);
    expect(dynamicImports[0].module_path).toBe('./module.js');
  });

  it('captures require() module paths', async () => {
    const parser = await getParser(),
      code = `const fs = require('fs');`,
      result = parser.extractCalleesFromContent('test.js', code),
      requires = result.filter((c) => c.callee === 'require' && c.module_path);
    expect(requires.length).toBeGreaterThanOrEqual(1);
    expect(requires[0].module_path).toBe('fs');
  });

  it('marks eval() calls as dynamic', async () => {
    const parser = await getParser(),
      code = `eval(userInput);`,
      result = parser.extractCalleesFromContent('test.js', code),
      evals = result.filter((c) => c.callee === 'eval');
    expect(evals.length).toBeGreaterThanOrEqual(1);
  });

  it('captures tagged template literals', async () => {
    const parser = await getParser(),
      code = `const btn = styled.button\`color: red;\`;
console.log(btn);`,
      result = parser.extractCalleesFromContent('test.js', code),
      // Tree-sitter parses tagged templates as call_expression with template_string args
      tagged = result.filter((c) => c.full_path === 'styled.button' || c.callee === 'styled.button');
    expect(tagged.length).toBeGreaterThanOrEqual(1);
  });

  it('records dynamic imports as symbols in parseContent', async () => {
    const parser = await getParser(),
      code = `const mod = import('./module.js');\nconst other = import('../utils');`,
      symbols = parser.parseContent('test.js', code),
      dynImports = symbols.filter((s) => s.kind === 'dynamic_import');
    expect(dynImports.length).toBeGreaterThanOrEqual(2);
    {
      const paths = dynImports.map((s) => s.name);
      expect(paths).toContain('./module.js');
      expect(paths).toContain('../utils');
    }
  });
});
