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

describe('_extractHtmlSymbolsAst (via parseContent)', () => {
  it('extracts id attributes with parent tag and byte offsets', async () => {
    const parser = await getParser(),
      html = `<div id="app">\n  <span id="title">Hello</span>\n</div>`,
      symbols = parser.parseContent('test.html', html),
      ids = symbols.filter((s) => s.kind === 'id');
    expect(ids.length).toBeGreaterThanOrEqual(2);
    {
const idNames = ids.map((s) => s.name);
    expect(idNames).toContain('app');
    expect(idNames).toContain('title');
    for (const id of ids) {
      expect(id.start_byte).toBeGreaterThan(-1);
      expect(id.end_byte).toBeGreaterThan(-1);
      expect(id.parent_name).toBeTruthy();
    }
  }
});

  it('extracts inline script blocks with byte offsets', async () => {
    const parser = await getParser(),
      html = `<script>\nfunction hello() {}\n</script>`,
      symbols = parser.parseContent('test.html', html),
      scripts = symbols.filter((s) => s.kind === 'script');
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const s of scripts) {
      expect(s.start_byte).toBeGreaterThan(-1);
      expect(s.end_byte).toBeGreaterThan(-1);
    }
  });

  it('extracts inline style blocks with byte offsets', async () => {
    const parser = await getParser(),
      html = `<style>\n.my-class { color: red; }\n</style>`,
      symbols = parser.parseContent('test.html', html),
      styles = symbols.filter((s) => s.kind === 'style');
    expect(styles.length).toBeGreaterThanOrEqual(1);
    for (const s of styles) {
      expect(s.start_byte).toBeGreaterThan(-1);
      expect(s.end_byte).toBeGreaterThan(-1);
    }
  });

  it('extracts custom element / component tags with attributes', async () => {
    const parser = await getParser(),
      html = `<MyButton>\n<app-header></app-header>\n</MyButton>`,
      symbols = parser.parseContent('test.html', html),
      components = symbols.filter((s) => s.kind === 'component');
    expect(components.length).toBeGreaterThanOrEqual(2);
    {
const names = components.map((s) => s.name);
    expect(names).toContain('MyButton');
    expect(names).toContain('app-header');
  }
});

  it('extracts class attributes with parent tag', async () => {
    const parser = await getParser(),
      html = `<div class="container active">\n  <p class="text-primary">Hi</p>\n</div>`,
      symbols = parser.parseContent('test.html', html),
      classes = symbols.filter((s) => s.kind === 'css_class');
    expect(classes.length).toBeGreaterThanOrEqual(3);
    {
const classNames = classes.map((s) => s.name);
    expect(classNames).toContain('container');
    expect(classNames).toContain('active');
    expect(classNames).toContain('text-primary');
  }
});

  it('returns empty array for empty HTML', async () => {
    const parser = await getParser(),
      symbols = parser.parseContent('test.html', '');
    expect(symbols).toEqual([]);
  });

  it('extracts heading symbols from h1-h6', async () => {
    const parser = await getParser(),
      html = `<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>`,
      symbols = parser.parseContent('test.html', html),
      headings = symbols.filter((s) => s.kind === 'heading');
    expect(headings).toHaveLength(3);
    {
const headingNames = headings.map((s) => s.name);
    expect(headingNames).toContain('Title');
    expect(headingNames).toContain('Subtitle');
    expect(headingNames).toContain('Section');
  }
});

  it('extracts semantic elements (nav, section, article, etc.)', async () => {
    const parser = await getParser(),
      html = `<nav><a href="/">Home</a></nav><article>Content</article><aside>Sidebar</aside>`,
      symbols = parser.parseContent('test.html', html),
      elements = symbols.filter((s) => s.kind === 'element');
    expect(elements.length).toBeGreaterThanOrEqual(3);
    {
const elemNames = elements.map((s) => s.name);
    expect(elemNames).toContain('<nav>');
    expect(elemNames).toContain('<article>');
    expect(elemNames).toContain('<aside>');
  }
});

  it('extracts meta tags with name and content', async () => {
    const parser = await getParser(),
      html = `<meta name="description" content="Test page"><meta name="viewport" content="width=device-width">`,
      symbols = parser.parseContent('test.html', html),
      metas = symbols.filter((s) => s.kind === 'meta');
    expect(metas.length).toBeGreaterThanOrEqual(2);
    {
const metaNames = metas.map((s) => s.name);
    expect(metaNames).toContain('description');
    expect(metaNames).toContain('viewport');
  }
});

  it('extracts link references (href, src)', async () => {
    const parser = await getParser(),
      html = `<a href="/home">Home</a><img src="logo.png"><script src="app.js"></script>`,
      symbols = parser.parseContent('test.html', html),
      links = symbols.filter((s) => s.kind === 'link_ref');
    expect(links.length).toBeGreaterThanOrEqual(3);
    {
const linkNames = links.map((s) => s.name);
    expect(linkNames).toContain('/home');
    expect(linkNames).toContain('logo.png');
    expect(linkNames).toContain('app.js');
  }
});

  it('extracts form controls with name and type', async () => {
    const parser = await getParser(),
      html = `<form action="/submit"><input type="email" name="addr" /><button type="submit">Go</button></form>`,
      symbols = parser.parseContent('test.html', html),
      forms = symbols.filter((s) => s.kind === 'form_control');
    expect(forms.length).toBeGreaterThanOrEqual(3);
    {
const formNames = forms.map((s) => s.name);
    expect(formNames).toContain('form');
    expect(formNames).toContain('addr');
    expect(formNames).toContain('submit');
  }
});

  it('extracts ARIA attributes', async () => {
    const parser = await getParser(),
      html = `<nav aria-label="main"><button aria-expanded="true">Menu</button></nav>`,
      symbols = parser.parseContent('test.html', html),
      aria = symbols.filter((s) => s.kind === 'aria');
    expect(aria.length).toBeGreaterThanOrEqual(2);
    {
const ariaNames = aria.map((s) => s.name);
    expect(ariaNames).toContain('main');
    expect(ariaNames).toContain('true');
  }
});

  it('extracts data-* attributes', async () => {
    const parser = await getParser(),
      html = `<div data-section="hero" data-index="0">Content</div>`,
      symbols = parser.parseContent('test.html', html),
      dataAttrs = symbols.filter((s) => s.kind === 'data_attr');
    expect(dataAttrs.length).toBeGreaterThanOrEqual(2);
    {
const dataNames = dataAttrs.map((s) => s.name);
    expect(dataNames).toContain('data-section');
    expect(dataNames).toContain('data-index');
  }
});

  it('extracts microdata attributes (itemscope, itemtype, itemprop)', async () => {
    const parser = await getParser(),
      html = `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Widget</span></div>`,
      symbols = parser.parseContent('test.html', html),
      micro = symbols.filter((s) => s.kind === 'microdata');
    expect(micro.length).toBeGreaterThanOrEqual(2);
  });

  it('provides accurate line numbers for multiline HTML', async () => {
    const parser = await getParser(),
      html = `<!DOCTYPE html>
<html>
<head>
  <title>Test</title>
</head>
<body>
  <div id="main">Content</div>
</body>
</html>`,
      symbols = parser.parseContent('test.html', html),
      ids = symbols.filter((s) => s.kind === 'id');
    expect(ids).toHaveLength(1);
    expect(ids[0].name).toBe('main');
    expect(ids[0].start_line).toBe(7);
    expect(ids[0].start_byte).toBeGreaterThan(0);
  });

  it('handles self-closing void elements', async () => {
    const parser = await getParser(),
      html = `<input type="text" name="field" /><br/><img src="pic.png" />`,
      symbols = parser.parseContent('test.html', html),
      forms = symbols.filter((s) => s.kind === 'form_control'), links = symbols.filter((s) => s.kind === 'link_ref');
    expect(forms.length).toBeGreaterThanOrEqual(1);
    
    expect(links.some((s) => s.name === 'pic.png')).toBe(true);
  });
});
