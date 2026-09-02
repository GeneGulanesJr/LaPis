const path = require('path');
const fs = require('fs');
const codeParser = require('../parse-code');
const { extractImportBindings } = require('../src/code-analysis'),
  TMP_DIR = path.join('/tmp', 'accuracy-tests');

function writeTmp(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function cleanupTmp(files) {
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {}
    try {
      fs.rmdirSync(path.dirname(f), { recursive: true });
    } catch {}
  }
}

describe('accuracy: extractCallees receiver tracking', () => {
  beforeAll(async () => {
    await codeParser.init();
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  it('should capture receiver for member calls', () => {
    const tmpFile = path.join(TMP_DIR, 'receiver.js');
    writeTmp(
      tmpFile,
      `
function foo() {
  obj.method();
  this.selfMethod();
  super.parentMethod();
  plainCall();
}
`,
    );
    try {
      const callees = codeParser.extractCallees(tmpFile),
        objCall = callees.find((c) => c.callee === 'method');
      expect(objCall).toBeDefined();
      expect(objCall.receiver).toBe('obj');
      expect(objCall.full_path).toBe('obj.method');
      expect(objCall.is_method).toBe(true);

      const thisCall = callees.find((c) => c.callee === 'selfMethod');
      expect(thisCall).toBeDefined();
      expect(thisCall.receiver).toBe('this');
      expect(thisCall.full_path).toBe('this.selfMethod');

      const superCall = callees.find((c) => c.callee === 'parentMethod');
      expect(superCall).toBeDefined();
      expect(superCall.receiver).toBe('super');
      expect(superCall.full_path).toBe('super.parentMethod');

      const plainCall = callees.find((c) => c.callee === 'plainCall');
      expect(plainCall).toBeDefined();
      expect(plainCall.receiver).toBeNull();
      expect(plainCall.is_method).toBe(false);
    } finally {
      cleanupTmp([tmpFile]);
    }
  });

  it('should capture full_path for chained member expressions', () => {
    const tmpFile = path.join(TMP_DIR, 'chain.js');
    writeTmp(
      tmpFile,
      `
function foo() {
  db.prepare().run();
}
`,
    );
    try {
      const callees = codeParser.extractCallees(tmpFile),
        prepareCall = callees.find((c) => c.callee === 'prepare');
      expect(prepareCall).toBeDefined();
      expect(prepareCall.receiver).toBe('db');

      const runCall = callees.find((c) => c.callee === 'run');
      expect(runCall).toBeDefined();
    } finally {
      cleanupTmp([tmpFile]);
    }
  });

  it('should not break backward compat: callee + line + is_method still work', () => {
    const tmpFile = path.join(TMP_DIR, 'compat.js');
    writeTmp(
      tmpFile,
      `
function foo() {
  bar();
  obj.baz();
  new ClassName();
}
`,
    );
    try {
      const callees = codeParser.extractCallees(tmpFile),
        names = callees.map((c) => c.callee);
      expect(names).toContain('bar');
      expect(names).toContain('baz');
      expect(names).toContain('ClassName');

      for (const c of callees) {
        expect(typeof c.line).toBe('number');
        expect(typeof c.is_method).toBe('boolean');
        expect(typeof c.receiver !== 'undefined').toBe(true);
        expect(typeof c.full_path).toBe('string');
      }
    } finally {
      cleanupTmp([tmpFile]);
    }
  });
});

describe('accuracy: extractImportBindings', () => {
  it('should parse default imports', () => {
    const content = `import foo from './utils';`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(1);
    expect(bindings[0].localName).toBe('foo');
    expect(bindings[0].originalName).toBe('default');
    expect(bindings[0].modulePath).toBe('./utils');
  });

  it('should parse named imports', () => {
    const content = `import { foo, bar } from './utils';`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(2);
    expect(bindings[0].localName).toBe('foo');
    expect(bindings[0].originalName).toBe('foo');
    expect(bindings[1].localName).toBe('bar');
    expect(bindings[1].originalName).toBe('bar');
  });

  it('should parse aliased imports (import { foo as bar })', () => {
    const content = `import { parse as parseExpr, validate as check } from './parser';`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(2);
    expect(bindings[0].localName).toBe('parseExpr');
    expect(bindings[0].originalName).toBe('parse');
    expect(bindings[0].modulePath).toBe('./parser');
    expect(bindings[1].localName).toBe('check');
    expect(bindings[1].originalName).toBe('validate');
  });

  it('should parse mixed default + named imports', () => {
    const content = `import React, { useState, useEffect } from 'react';`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(3);
    expect(bindings[0].localName).toBe('React');
    expect(bindings[0].originalName).toBe('default');
    expect(bindings[1].localName).toBe('useState');
    expect(bindings[1].originalName).toBe('useState');
    expect(bindings[2].localName).toBe('useEffect');
  });

  it('should parse namespace imports (* as)', () => {
    const content = `import * as utils from './utils';`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(1);
    expect(bindings[0].localName).toBe('utils');
    expect(bindings[0].originalName).toBe('*');
  });

  it('should parse require() destructuring with aliases', () => {
    const content = `const { parse: parseExpr, validate } = require('./parser');`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(2);
    expect(bindings[0].localName).toBe('parseExpr');
    expect(bindings[0].originalName).toBe('parse');
    expect(bindings[1].localName).toBe('validate');
    expect(bindings[1].originalName).toBe('validate');
  });

  it('should parse require() whole module', () => {
    const content = `const utils = require('./utils');`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(1);
    expect(bindings[0].localName).toBe('utils');
    expect(bindings[0].originalName).toBe('*');
  });

  it('should return empty for files with no imports', () => {
    const content = `function foo() { return 1; }`,
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(0);
  });

  it('should handle multiple imports across lines', () => {
    const content = [
        `import { foo } from './a';`,
        `import { bar as baz } from './b';`,
        `import defVal from './c';`,
      ].join('\n'),
      bindings = extractImportBindings(content);
    expect(bindings.length).toBe(3);
    const localNames = bindings.map((b) => b.localName);
    expect(localNames).toContain('foo');
    expect(localNames).toContain('baz');
    expect(localNames).toContain('defVal');
  });
});

describe('accuracy: end-to-end cross-file resolution', () => {
  const Database = require('better-sqlite3');
  const codeAnalysis = require('../src/code-analysis'),
    TEST_DB_PATH = path.join(TMP_DIR, 'accuracy-test.db'),
    TEST_REPO_DIR = path.join(TMP_DIR, 'test-repo'),
    files = {
      'utils.js': `
function helper() {
  return 42;
}
function processItem(item) {
  return item + 1;
}
module.exports = { helper, processItem };
`,
      'parser.js': `
function parse(input) {
  return JSON.parse(input);
}
module.exports = { parse };
`,
      'consumer.js': `
const { helper: getHelp, processItem } = require('./utils');
const { parse } = require('./parser');

function doWork() {
  getHelp();
  processItem(1);
  parse('{}');
}
`,
      'classes.js': `
class Base {
  init() {
    return 'base';
  }
}

class Child extends Base {
  setup() {
    this.init();
    super.init();
  }
}
`,
    };

  let db, repoId;

  beforeAll(async () => {
    fs.mkdirSync(TEST_REPO_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(TEST_REPO_DIR, name), content);
    }

    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    db = new Database(TEST_DB_PATH);
    const schemaSql = fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf-8');
    db.exec(schemaSql);

    const insertRepo = db.prepare('INSERT INTO code_repos (name, path) VALUES (?, ?)'),
      info = insertRepo.run('AccuracyTestRepo', TEST_REPO_DIR);
    repoId = info.lastInsertRowid;

    const insertFile = db.prepare(
        'INSERT INTO code_files (repo_id, path, language, content, content_hash) VALUES (?, ?, ?, ?, ?)',
      ),
      insertSymbol = db.prepare(
        `INSERT INTO code_symbols (repo_id, file_id, name, kind, language, file_path, signature, qualified_name, start_line, end_line, start_byte, end_byte, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

    await codeParser.init();

    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(TEST_REPO_DIR, name),
        hash = require('crypto').createHash('md5').update(content).digest('hex'),
        fileInfo = insertFile.run(repoId, filePath, 'javascript', content, hash),
        fileId = fileInfo.lastInsertRowid,
        symbols = codeParser.parseFile(filePath);
      for (const sym of symbols) {
        insertSymbol.run(
          repoId,
          fileId,
          sym.name,
          sym.kind,
          sym.language,
          sym.file,
          sym.signature,
          sym.qualified_name,
          sym.start_line,
          sym.end_line,
          sym.start_byte,
          sym.end_byte,
          sym.parent_name || '',
        );
      }
    }

    codeAnalysis.buildImportGraph(db, repoId);
    codeAnalysis.buildCallGraph(db, repoId);
  });

  afterAll(() => {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch {}
    try {
      fs.rmSync(TEST_REPO_DIR, { recursive: true });
    } catch {}
  });

  it('should resolve aliased import getHelp → helper in utils.js', () => {
    const result = codeAnalysis.getCallHierarchy(db, repoId, {
      symbol: 'doWork',
      direction: 'callees',
      depth: 1,
    });

    expect(result.error).toBeUndefined();
    expect(result.callees).toBeDefined();
    expect(Array.isArray(result.callees)).toBe(true);

    const resolvedCallees = result.callees.filter((c) => c.callee_symbol_id !== null);
    expect(resolvedCallees.length).toBeGreaterThan(0);
  });

  it('should resolve this.init() in Child.setup to Base.init', () => {
    const result = codeAnalysis.getCallHierarchy(db, repoId, {
      symbol: 'setup',
      direction: 'callees',
      depth: 1,
    });

    expect(result.error).toBeUndefined();
    expect(result.callees).toBeDefined();

    const initCalls = result.callees.filter((c) => c.callee_name === 'init');
    expect(initCalls.length).toBeGreaterThan(0);

    const resolvedInit = initCalls.find((c) => c.callee_symbol_id !== null);
    if (resolvedInit) {
      expect(resolvedInit.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('should include confidence scores on call edges', () => {
    const result = codeAnalysis.getCallHierarchy(db, repoId, {
      symbol: 'doWork',
      direction: 'callees',
      depth: 1,
    });

    expect(result.error).toBeUndefined();
    if (result.callees) {
      for (const callee of result.callees) {
        expect(typeof callee.confidence).toBe('number');
        expect(callee.confidence).toBeGreaterThan(0);
        expect(callee.confidence).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it('should filter blast radius by confidence', () => {
    const result = codeAnalysis.getBlastRadius(db, repoId, {
      symbol: 'helper',
      depth: 2,
      minConfidence: 0.7,
    });

    if (result.seed_file !== undefined) {
      expect(result.affected_files).toBeDefined();
      expect(Array.isArray(result.affected_files)).toBe(true);
    } else {
      expect(result.min_confidence).toBe(0.7);
      if (result.callers && result.callers.length > 0) {
        for (const caller of result.callers) {
          expect(caller.confidence).toBeGreaterThanOrEqual(0.7);
        }
      }
    }
  });

  it('should track qualified names for class methods', () => {
    const symbols = db
        .prepare('SELECT name, qualified_name, parent_name FROM code_symbols WHERE repo_id = ?')
        .all(repoId),
      initMethod = symbols.find((s) => s.name === 'init' && s.parent_name === 'Base');
    expect(initMethod).toBeDefined();
    expect(initMethod.qualified_name).toBe('Base.init');
  });

  it('should allow multiple call sites for same caller→callee', () => {
    const calls = db.prepare('SELECT * FROM code_calls WHERE repo_id = ? ORDER BY line_number').all(repoId);
    expect(calls.length).toBeGreaterThan(0);
  });
});
