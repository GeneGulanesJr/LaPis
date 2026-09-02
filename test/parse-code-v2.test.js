const path = require('path'),
  fs = require('fs'),
  codeParser = require('../parse-code');

function writeTmp(filePath, content) {
  fs.writeFileSync(filePath, content);
  return codeParser.parseFile(filePath);
}

function cleanup(...files) {
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

function calleesFor(filePath, content) {
  return codeParser.extractCalleesFromContent(filePath, content);
}

describe('parse-code v2 fixes', () => {
  beforeAll(async () => {
    await codeParser.init();
  });

  describe('fix 1: JS/TS depth gating removed', () => {
    it('extracts nested arrow functions inside functions', () => {
      const f = path.join('/tmp', 'v2-nested-arrow.js'),
        syms = writeTmp(
          f,
          `
function outer() {
  const inner = (x) => x + 1;
  return inner(5);
}`,
        ),
        outer = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'outer');
        })(),
        inner = (() => {
          expect(outer).toBeDefined();
          expect(outer.kind).toBe('function');

          return syms.find((s) => s.name === 'inner');
        })();
      expect(inner).toBeDefined();
      expect(inner.kind).toBe('function');
    });

    it('extracts nested function expressions in callbacks', () => {
      const f = path.join('/tmp', 'v2-nested-expr.js'),
        syms = writeTmp(
          f,
          `
const items = [1, 2, 3];
const filtered = items.filter((x) => x > 1);
`,
        ),
        filtered = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'filtered');
        })();
      expect(filtered).toBeDefined();
      expect(filtered.kind).toBe('constant');
    });

    it('extracts variable declarators at nested depth', () => {
      const f = path.join('/tmp', 'v2-nested-var.js'),
        syms = writeTmp(
          f,
          `
function main() {
  const API_URL = 'http://example.com';
  let counter = 0;
}
`,
        ),
        apiUrl = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'API_URL');
        })();
      expect(apiUrl).toBeDefined();
      expect(apiUrl.kind).toBe('constant');
    });
  });

  describe('fix 2: Rust depth gating removed', () => {
    it('extracts nested functions inside impl blocks', () => {
      const f = path.join('/tmp', 'v2-rust-impl.rs'),
        syms = writeTmp(
          f,
          `
struct Foo;

impl Foo {
    fn bar(&self) {
        // method body
    }
    fn baz(&self, x: i32) -> i32 {
        x + 1
    }
}
`,
        ),
        foo = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'Foo' && s.kind === 'class');
        })();
      expect(foo).toBeDefined();
      {
        const bar = syms.find((s) => s.name === 'bar'),
          baz = (() => {
            expect(bar).toBeDefined();
            expect(bar.kind).toBe('function');

            return syms.find((s) => s.name === 'baz');
          })();
        expect(baz).toBeDefined();
      }
    });

    it('extracts Rust mod items', () => {
      const f = path.join('/tmp', 'v2-rust-mod.rs'),
        syms = writeTmp(
          f,
          `
mod models;
mod handlers {
    pub fn index() {}
}
`,
        ),
        models = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'models' && s.kind === 'module');
        })(),
        handlers = (() => {
          expect(models).toBeDefined();

          return syms.find((s) => s.name === 'handlers' && s.kind === 'module');
        })();
      expect(handlers).toBeDefined();
    });

    it('extracts Rust use declarations', () => {
      const f = path.join('/tmp', 'v2-rust-use.rs'),
        syms = writeTmp(
          f,
          `
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
fn main() {}
`,
        ),
        useSym = (() => {
          cleanup(f);

          return syms.find((s) => s.kind === 'import');
        })();
      expect(useSym).toBeDefined();
      expect(useSym.name).toContain('std');
    });

    it('extracts Rust macro definitions', () => {
      const f = path.join('/tmp', 'v2-rust-macro.rs'),
        syms = writeTmp(
          f,
          `
macro_rules! vec {
    ( $( $x:expr ),* ) => {
        {
            let mut temp_vec = Vec::new();
            $(
                temp_vec.push($x);
            )*
            temp_vec
        }
    };
}
`,
        ),
        vec = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'vec');
        })();
      expect(vec).toBeDefined();
      expect(vec.kind).toBe('function');
    });
  });

  describe('fix 3: Multi-language callee extraction', () => {
    it('extracts Python callees from call nodes', () => {
      const py = path.join('/tmp', 'v2-py-callees.py'),
        content = 'result = process(data)\nobj.transform(x)\nprint("hello")\n',
        cal = calleesFor(py, content),
        names = cal.map((c) => c.callee),
        transform = (() => {
          expect(names).toContain('process');
          expect(names).toContain('transform');
          expect(names).toContain('print');

          return cal.find((c) => c.callee === 'transform');
        })();
      expect(transform.is_method).toBe(true);
      expect(transform.receiver).toBe('obj');
    });

    it('extracts Go callees from selector expressions', () => {
      const go = path.join('/tmp', 'v2-go-callees.go'),
        content = 'package main\n\nfunc main() {\n\tfmt.Println("hi")\n\tos.Exit(1)\n}\n',
        cal = calleesFor(go, content),
        names = cal.map((c) => c.callee),
        println = (() => {
          expect(names).toContain('Println');
          expect(names).toContain('Exit');

          return cal.find((c) => c.callee === 'Println');
        })();
      expect(println.is_method).toBe(true);
    });

    it('extracts Rust callees from field expressions', () => {
      const rs = path.join('/tmp', 'v2-rust-callees.rs'),
        content = 'fn main() {\n    let v = Vec::new();\n    v.push(1);\n    println!("hi");\n}\n',
        cal = calleesFor(rs, content),
        names = cal.map((c) => c.callee),
        push = (() => {
          expect(names).toContain('push');

          return cal.find((c) => c.callee === 'push');
        })();
      expect(push.is_method).toBe(true);
    });
  });

  describe('fix 4: Docstring extraction for Python/Go/Rust', () => {
    it('extracts Python docstrings from triple-quoted strings', () => {
      const f = path.join('/tmp', 'v2-py-doc.py'),
        syms = writeTmp(
          f,
          `
def greet(name):
    """Say hello to someone."""
    return f"Hello {name}"

class Animal:
    """Base animal class."""
    def speak(self):
        """Make a sound."""
        return "roar"
`,
        ),
        greet = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'greet');
        })();
      expect(greet).toBeDefined();
      expect(greet.docstring).toContain('Say hello');
      {
        const animal = syms.find((s) => s.name === 'Animal'),
          speak = (() => {
            expect(animal).toBeDefined();
            expect(animal.docstring).toContain('Base animal');

            return syms.find((s) => s.name === 'speak');
          })();
        expect(speak).toBeDefined();
        expect(speak.docstring).toContain('Make a sound');
      }
    });

    it('extracts Go doc comments', () => {
      const f = path.join('/tmp', 'v2-go-doc.go'),
        syms = writeTmp(
          f,
          `package main

// Greet says hello to the given name.
func Greet(name string) string {
	return "Hello " + name
}
`,
        ),
        greet = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'Greet');
        })();
      expect(greet).toBeDefined();
      expect(greet.docstring).toContain('says hello');
    });

    it('extracts Rust /// doc comments', () => {
      const f = path.join('/tmp', 'v2-rust-doc.rs'),
        syms = writeTmp(
          f,
          `/// Adds two numbers together.
/// Returns the sum.
fn add(a: i32, b: i32) -> i32 {
    a + b
}
`,
        ),
        add = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'add');
        })();
      expect(add).toBeDefined();
      expect(add.docstring).toContain('Adds two numbers');
      expect(add.docstring).toContain('Returns the sum');
    });
  });

  describe('enrichment: Python module-level variables', () => {
    it('extracts module-level assignments', () => {
      const f = path.join('/tmp', 'v2-py-vars.py'),
        syms = writeTmp(
          f,
          `CONFIG = {"debug": True}
MAX_RETRIES = 3
UserId = int
`,
        ),
        config = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'CONFIG');
        })();
      expect(config).toBeDefined();
      expect(config.kind).toBe('constant');
      {
        const retries = syms.find((s) => s.name === 'MAX_RETRIES'),
          uid = (() => {
            expect(retries).toBeDefined();

            return syms.find((s) => s.name === 'UserId');
          })();
        expect(uid).toBeDefined();
      }
    });
  });

  describe('enrichment: Go var/const and imports', () => {
    it('extracts Go var and const declarations', () => {
      const f = path.join('/tmp', 'v2-go-vars.go'),
        syms = writeTmp(
          f,
          `package main

const MaxSize = 100
var DefaultName = "world"
`,
        ),
        maxSize = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'MaxSize');
        })(),
        name = (() => {
          expect(maxSize).toBeDefined();
          expect(maxSize.kind).toBe('constant');

          return syms.find((s) => s.name === 'DefaultName');
        })();
      expect(name).toBeDefined();
    });

    it('extracts Go import declarations', () => {
      const f = path.join('/tmp', 'v2-go-import.go'),
        syms = writeTmp(
          f,
          `package main

import "fmt"
import (
    "os"
    "strings"
)
`,
        ),
        imports = (() => {
          cleanup(f);

          return syms.filter((s) => s.kind === 'import');
        })(),
        names = (() => {
          expect(imports.length).toBeGreaterThanOrEqual(3);

          return imports.map((s) => s.name);
        })();
      expect(names).toContain('fmt');
      expect(names).toContain('os');
      expect(names).toContain('strings');
    });
  });

  describe('enrichment: Rust enum variants and macro', () => {
    it('extracts Rust enum variants', () => {
      const f = path.join('/tmp', 'v2-rust-enum.rs'),
        syms = writeTmp(
          f,
          `enum Color {
    Red,
    Green,
    Blue,
}
`,
        ),
        color = (() => {
          cleanup(f);

          return syms.find((s) => s.name === 'Color');
        })(),
        red = (() => {
          expect(color).toBeDefined();
          expect(color.kind).toBe('enum');

          return syms.find((s) => s.name === 'Red');
        })();
      if (red) {
        expect(red.parent_name).toBe('Color');
      }
    });
  });

  describe('enrichment: Python import tracking', () => {
    it('extracts Python import statements', () => {
      const f = path.join('/tmp', 'v2-py-imports.py'),
        syms = writeTmp(
          f,
          `import os
import sys
from collections import defaultdict
from typing import List, Dict
`,
        ),
        imports = (() => {
          cleanup(f);

          return syms.filter((s) => s.kind === 'import');
        })();
      expect(imports.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('diagnostics: parse failure detection', () => {
    it('returns diagnostic symbol for unsupported extensions', () => {
      const f = path.join('/tmp', 'v2-diag.rb');
      fs.writeFileSync(f, 'def hello; end');
      try {
        const syms = codeParser.parseFile(f),
          diag = syms.find((s) => s.kind === 'diagnostic');
        expect(diag).toBeDefined();
        expect(diag.signature).toContain('not supported');
      } finally {
        cleanup(f);
      }
    });

    it('returns diagnostic symbol for known extension without grammar', () => {
      const origParsers = codeParser.info();
      if (!origParsers.ready) {
        const syms = codeParser.parseFile('/tmp/test-fail.js'),
          diag = syms.find((s) => s.kind === 'diagnostic');
        expect(diag).toBeDefined();
        expect(diag.signature).toContain('not initialized');
      }
    });
  });
});
