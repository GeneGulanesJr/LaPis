// Parity guard: the MCP catalog must mirror the Pi extension's tool surface.
// Parses the TS source statically (no TS compiler needed) so a drift between
// Extensions/memory-layer/tools/*.ts and src/mcp/tools.js fails loudly here
// Before it ships.
//
// This test exists because the two adapters are intentionally separate code
// Paths (Pi uses registerTool+renderResult; MCP uses raw JSON schemas). If
// Someone adds a tool/mode to one adapter and forgets the other, this catches
// It. Pattern follows test/memory-client-dispatch.test.ts (static source-text
// Regression test). Uses vitest globals — no import needed.

const fs = require('node:fs'), path = require('node:path'),
  repoRoot = path.resolve(__dirname, '..');


function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('MCP ↔ Pi extension tool parity', () => {
  const { tools, CODE_MODE_TO_COMMAND, DOC_MODE_TO_COMMAND } = require('../src/mcp/tools'),
    mcpNames = new Set(tools.map((t) => t.name));

  // Tool names registered in extensions/memory-layer/tools/*.ts via pi.registerTool.
  // Extracted statically from the TS source (no TS compiler) so the parity guard
  // Breaks loudly if either adapter adds/removes a tool. Names must match exactly:
  // The Pi extension uses kebab-case, so the MCP catalog mirrors it (src/mcp/tools.js).
  function piRegisteredToolNames() {
    const files = [
        'extensions/memory-layer/tools/memory-tools.ts',
        'extensions/memory-layer/tools/code-tools.ts',
        'extensions/memory-layer/tools/doc-tools.ts',
      ],
      names = [];
    for (const rel of files) {
      const src = read(rel),
        re = /registerTool\(\s*\{\s*name:\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        names.push(m[1]);
      }
    }
    return names;
  }

  it('MCP exposes every tool the Pi extension registers (names match exactly)', () => {
    const piToolNames = piRegisteredToolNames();
    expect(piToolNames.length, 'found no registerTool names in Pi extension source').toBeGreaterThan(0);
    for (const name of piToolNames) {
      expect(mcpNames.has(name), `MCP missing tool "${name}" registered in Pi extension`).toBe(true);
    }
  });

  it('MCP memory-code mode list matches the enum in code-tools.ts', () => {
    const codeToolsSrc = read('extensions/memory-layer/tools/code-tools.ts'),
      // Extract the enum array from: enum: [ 'search', 'callers', ... ]
      enumMatch = codeToolsSrc.match(/mode:\s*Type\.Optional\([\s\S]*?enum:\s*\[([\s\S]*?)\]/), piModes = enumMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"`]/g, ''))
        .filter(Boolean),
      mcpModes = Object.keys(CODE_MODE_TO_COMMAND);
    expect(enumMatch, 'could not find mode enum in code-tools.ts').not.toBeNull();
    
    expect([...piModes].sort()).toEqual([...mcpModes].sort());
  });

  it('MCP memory-doc mode list matches the enum in doc-tools.ts', () => {
    const docToolsSrc = read('extensions/memory-layer/tools/doc-tools.ts'),
      enumMatch = docToolsSrc.match(/mode:\s*Type\.Optional\([\s\S]*?enum:\s*\[([\s\S]*?)\]/), piModes = enumMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"`]/g, ''))
        .filter(Boolean),
      mcpModes = Object.keys(DOC_MODE_TO_COMMAND);
    expect(enumMatch, 'could not find mode enum in doc-tools.ts').not.toBeNull();
    
    expect([...piModes].sort()).toEqual([...mcpModes].sort());
  });

  it('every MCP code mode maps to the same command as code-tools.ts cmdMap', () => {
    const codeToolsSrc = read('extensions/memory-layer/tools/code-tools.ts'),
      // Extract cmdMap entries: search: 'search-code', and 'blast-radius': 'blast-radius',
      cmdMapBlock = codeToolsSrc.match(/const cmdMap[^{]*\{([\s\S]*?)\};/), piMap = {},
      // Match both bare (search:) and quoted ('blast-radius':) keys.
      entryRe = /['"]?([a-z-]+)['"]?\s*:\s*['"]([a-z-]+)['"]/g;
    expect(cmdMapBlock, 'could not find cmdMap in code-tools.ts').not.toBeNull();
    
    let m;
    while ((m = entryRe.exec(cmdMapBlock[1])) !== null) {
      piMap[m[1]] = m[2];
    }
    for (const [mode, cmd] of Object.entries(CODE_MODE_TO_COMMAND)) {
      expect(piMap[mode], `Pi cmdMap missing mode "${mode}"`).toBeDefined();
      expect(piMap[mode], `mode "${mode}" diverges: MCP=${cmd} Pi=${piMap[mode]}`).toBe(cmd);
    }
  });

  it('every MCP doc mode maps to the same command as doc-tools.ts cmdMap', () => {
    const docToolsSrc = read('extensions/memory-layer/tools/doc-tools.ts'),
      cmdMapBlock = docToolsSrc.match(/const cmdMap[^{]*\{([\s\S]*?)\};/), piMap = {},
      entryRe = /['"]?([a-z-]+)['"]?\s*:\s*['"]([a-z-]+)['"]/g;
    expect(cmdMapBlock, 'could not find cmdMap in doc-tools.ts').not.toBeNull();
    
    let m;
    while ((m = entryRe.exec(cmdMapBlock[1])) !== null) {
      piMap[m[1]] = m[2];
    }
    for (const [mode, cmd] of Object.entries(DOC_MODE_TO_COMMAND)) {
      expect(piMap[mode], `Pi cmdMap missing mode "${mode}"`).toBeDefined();
      expect(piMap[mode], `mode "${mode}" diverges: MCP=${cmd} Pi=${piMap[mode]}`).toBe(cmd);
    }
  });
});
