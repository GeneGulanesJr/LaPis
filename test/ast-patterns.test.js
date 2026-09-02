// Tests for ast-patterns.js — anti-pattern detection
const astPatterns = require('../ast-patterns');

describe('ast-patterns.js', () => {
  describe('PRESET_DETECTORS', () => {
    it('should have at least 8 preset detectors covering all categories', () => {
      expect(astPatterns.PRESET_DETECTORS.length).toBeGreaterThanOrEqual(8);
      // Verify category coverage
      const categories = new Set(astPatterns.PRESET_DETECTORS.map((d) => d.category));
      expect(categories.has('error_handling')).toBe(true);
      expect(categories.has('quality')).toBe(true);
      expect(categories.has('complexity')).toBe(true);
      expect(categories.has('performance')).toBe(true);
      expect(categories.has('security')).toBe(true);
      expect(categories.has('maintenance')).toBe(true);
    });

    it('should have unique IDs', () => {
      const ids = astPatterns.PRESET_DETECTORS.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid categories', () => {
      const validCategories = ['error_handling', 'quality', 'complexity', 'performance', 'security', 'maintenance'];
      for (const d of astPatterns.PRESET_DETECTORS) {
        expect(validCategories).toContain(d.category);
      }
    });

    it('should have severity levels', () => {
      const validSeverities = ['info', 'warning', 'error'];
      for (const d of astPatterns.PRESET_DETECTORS) {
        expect(validSeverities).toContain(d.severity);
      }
    });
  });

  describe('empty_catch detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'empty_catch');

    it('should detect empty catch blocks', () => {
      const result = detector.detect(
        {
          body_preview: 'try { something(); } catch (e) { }',
          start_line: 10,
        },
        null,
      );
      expect(result).not.toBeNull();
      expect(result.count).toBe(1);
    });

    it('should not detect non-empty catch blocks', () => {
      const result = detector.detect(
        {
          body_preview: 'try { something(); } catch (e) { handleError(e); }',
          start_line: 10,
        },
        null,
      );
      expect(result).toBeNull();
    });

    it('should return null for missing body', () => {
      const result = detector.detect({ body_preview: null }, null);
      expect(result).toBeNull();
    });
  });

  describe('empty_function detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'empty_function');

    it('should detect empty function via body_preview', () => {
      const result = detector.detect(
        {
          kind: 'function',
          body_preview: '',
          start_line: 5,
          end_line: 5,
        },
        null,
      );
      expect(result).not.toBeNull();
    });

    it('should not flag non-function symbols', () => {
      const result = detector.detect({ kind: 'class', body_preview: '' }, null);
      expect(result).toBeNull();
    });
  });

  describe('eval_exec detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'eval_exec');

    it('should detect eval()', () => {
      const result = detector.detect(
        {
          body_preview: 'const x = eval("2 + 2");',
          start_line: 1,
        },
        null,
      );
      expect(result).not.toBeNull();
    });

    it('should detect new Function()', () => {
      const result = detector.detect(
        {
          body_preview: 'const fn = new Function("a", "b", "return a + b");',
          start_line: 1,
        },
        null,
      );
      expect(result).not.toBeNull();
    });

    it('should return null for clean code', () => {
      const result = detector.detect(
        {
          body_preview: 'const x = a + b; return x;',
          start_line: 1,
        },
        null,
      );
      expect(result).toBeNull();
    });
  });

  describe('hardcoded_secret detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'hardcoded_secret');

    it('should detect password strings', () => {
      const result = detector.detect(
        {
          body_preview: 'const pw = "password123";',
          start_line: 1,
        },
        null,
      );
      expect(result).not.toBeNull();
    });

    it('should detect api_key strings', () => {
      const result = detector.detect(
        {
          body_preview: "const key = 'api_key_abc';",
          start_line: 1,
        },
        null,
      );
      expect(result).not.toBeNull();
    });
  });

  describe('todo_fixme detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'todo_fixme');

    it('should detect TODO comments', () => {
      const result = detector.detect(
        {
          body_preview: '// TODO: implement this later\nreturn 42;',
          start_line: 10,
        },
        null,
      );
      expect(result).not.toBeNull();
      expect(result.items[0].type).toBe('TODO');
    });

    it('should detect FIXME comments', () => {
      const result = detector.detect(
        {
          body_preview: '// FIXME: this is broken\nreturn null;',
          start_line: 10,
        },
        null,
      );
      expect(result).not.toBeNull();
      expect(result.items[0].type).toBe('FIXME');
    });
  });

  describe('nested_loops detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'nested_loops');

    it('should detect 3 nested loops via indentation', () => {
      const body = [
          'for (let i = 0; i < 10; i++) {',
          '  for (let j = 0; j < 10; j++) {',
          '    for (let k = 0; k < 10; k++) {',
          '      doSomething(i, j, k);',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        result = detector.detect({ body_preview: body, start_line: 1 }, null);
      expect(result).not.toBeNull();
      expect(result.loop_nesting_depth).toBe(3);
    });

    it('should not flag 2 nested loops', () => {
      const body = [
          'for (let i = 0; i < 10; i++) {',
          '  for (let j = 0; j < 10; j++) {',
          '    doSomething(i, j);',
          '  }',
          '}',
        ].join('\n'),
        result = detector.detect({ body_preview: body }, null);
      expect(result).toBeNull();
    });

    it('should return null for missing body', () => {
      const result = detector.detect({ body_preview: null }, null);
      expect(result).toBeNull();
    });
  });

  describe('magic_number detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'magic_number');

    it('should detect suspicious large numbers (>= 100)', () => {
      const result = detector.detect(
        {
          body_preview: 'const timeout = 5000;\nconst limit = 200;',
          start_line: 1,
        },
        null,
      );
      expect(result).not.toBeNull();
      // 50, 99, 200, 5000 — many numeric literals
      expect(result.count).toBeGreaterThanOrEqual(2);
    });

    it('should not flag common small numbers (0, 1, 2, -1)', () => {
      const result = detector.detect(
        {
          body_preview: 'const a = 0;\nconst b = 1;\nconst c = 2;\nconst d = -1;',
          start_line: 1,
        },
        null,
      );
      expect(result).toBeNull();
    });

    it('should return null when few magic numbers present', () => {
      const result = detector.detect(
        {
          body_preview: 'const width = 42;\nreturn width * 3;',
          start_line: 1,
        },
        null,
      );
      // Only 42 and 3 — less than 5 total matches, no notable (>99) numbers
      expect(result).toBeNull();
    });

    it('should return null for missing body', () => {
      const result = detector.detect({ body_preview: null }, null);
      expect(result).toBeNull();
    });
  });

  describe('reassigned_param detector', () => {
    const detector = astPatterns.PRESET_DETECTORS.find((d) => d.id === 'reassigned_param');

    it('should detect parameter reassignment', () => {
      const result = detector.detect(
        {
          signature: 'function foo(x, y) {',
          body_preview: 'x = x + 1;\nreturn x;',
          start_line: 1,
        },
        null,
      );
      expect(result).not.toBeNull();
    });

    it('should return null for no reassignment', () => {
      const result = detector.detect(
        {
          signature: 'function foo(x, y) {',
          body_preview: 'return x + y;',
          start_line: 1,
        },
        null,
      );
      expect(result).toBeNull();
    });
  });

  describe('parseCustomPattern', () => {
    it('should parse and run call patterns', () => {
      const parsed = astPatterns.parseCustomPattern('call:eval'),
        match = (() => {
          expect(parsed.error).toBeUndefined();
          expect(parsed.detect).toBeDefined();
          // Verify it actually detects

          return parsed.detect({ body_preview: 'eval("2+2")' });
        })(),
        noMatch = (() => {
          expect(match).not.toBeNull();
          expect(match.count).toBe(1);
          // Verify it doesn't false-positive

          return parsed.detect({ body_preview: 'return 42;' });
        })();
      expect(noMatch).toBeNull();
    });

    it('should parse and run string patterns', () => {
      const parsed = astPatterns.parseCustomPattern('string:todo'),
        match = (() => {
          expect(parsed.error).toBeUndefined();
          expect(parsed.detect).toBeDefined();
          // Verify it detects (case-sensitive by default)

          return parsed.detect({ body_preview: '// todo: fix later' });
        })(),
        noMatch = (() => {
          expect(match).not.toBeNull();
          expect(match.count).toBe(1);
          // Verify it doesn't false-positive

          return parsed.detect({ body_preview: 'all done here' });
        })();
      expect(noMatch).toBeNull();
    });

    it('should parse nesting patterns (with + suffix)', () => {
      const parsed = astPatterns.parseCustomPattern('nesting:5+');
      // ParseInt('5+') = 5, which is valid — no error
      expect(parsed.detect).toBeDefined();
    });

    it('should parse and run nesting with valid number', () => {
      const parsed = astPatterns.parseCustomPattern('nesting:5');
      expect(parsed.error).toBeUndefined();
      expect(parsed.detect).toBeDefined();
    });

    it('should parse and run lines patterns', () => {
      const parsed = astPatterns.parseCustomPattern('lines:80'),
        match = (() => {
          expect(parsed.error).toBeUndefined();
          expect(parsed.detect).toBeDefined();
          // Verify: symbol spanning lines 1-100 → 100 lines ≥ 80

          return parsed.detect({ start_line: 1, end_line: 100 });
        })(),
        noMatch = (() => {
          expect(match).not.toBeNull();
          expect(match.lines_of_code).toBe(100);
          // Verify: short symbol rejected

          return parsed.detect({ start_line: 1, end_line: 10 });
        })();
      expect(noMatch).toBeNull();
    });

    it('should handle values with colons', () => {
      const parsed = astPatterns.parseCustomPattern('string:/api/v1/users');
      expect(parsed.error).toBeUndefined();
    });

    it('should reject invalid patterns', () => {
      expect(astPatterns.parseCustomPattern('invalid').error).toBeDefined();
    });
  });

  describe('scanAstPatterns', () => {
    // ScanAstPatterns requires a real DB handle — verify it handles missing DB gracefully
    it('should handle null db gracefully', () => {
      const result = astPatterns.scanAstPatterns(null, 1, { category: 'all' });
      // Should return empty or error
      expect(result).toBeDefined();
    });
  });
});
