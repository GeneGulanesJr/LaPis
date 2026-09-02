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

describe('_extractCssSymbols (via parseContent)', () => {
  it('extracts CSS class selectors', async () => {
    const parser = await getParser(),
      css = `.container { display: flex; }\n.text-primary { color: blue; }`,
      symbols = parser.parseContent('test.css', css),
      classes = symbols.filter((s) => s.kind === 'selector'),
      names = classes.map((s) => s.name);
    expect(names).toContain('.container');
    expect(names).toContain('.text-primary');
  });

  it('extracts CSS custom properties', async () => {
    const parser = await getParser(),
      css = `:root {\n  --primary: #333;\n  --spacing: 1rem;\n}`,
      symbols = parser.parseContent('test.css', css),
      vars = symbols.filter((s) => s.kind === 'custom_property'),
      names = vars.map((s) => s.name);
    expect(names).toContain('--primary');
    expect(names).toContain('--spacing');
  });

  it('extracts @keyframes', async () => {
    const parser = await getParser(),
      css = `@keyframes fadeIn {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}`,
      symbols = parser.parseContent('test.css', css),
      kf = symbols.filter((s) => s.kind === 'keyframes');
    expect(kf.length).toBeGreaterThanOrEqual(1);
    expect(kf[0].name).toContain('fadeIn');
  });

  it('extracts @media queries', async () => {
    const parser = await getParser(),
      css = `@media (min-width: 768px) {\n  .container { max-width: 720px; }\n}`,
      symbols = parser.parseContent('test.css', css),
      media = symbols.filter((s) => s.kind === 'media_query');
    expect(media.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts SCSS variables', async () => {
    const parser = await getParser(),
      scss = `$primary: #333;\n$font-stack: Helvetica, sans-serif;`,
      symbols = parser.parseContent('test.scss', scss),
      vars = symbols.filter((s) => s.kind === 'scss_variable'),
      names = vars.map((s) => s.name);
    expect(names).toContain('$primary');
    expect(names).toContain('$font-stack');
  });

  it('extracts SCSS @mixin and @include', async () => {
    const parser = await getParser(),
      scss = `@mixin flex-center {\n  display: flex;\n  justify-content: center;\n}\n\n.container {\n  @include flex-center;\n}`,
      symbols = parser.parseContent('test.scss', scss),
      mixins = symbols.filter((s) => s.kind === 'mixin'),
      includes = symbols.filter((s) => s.kind === 'include');
    expect(mixins.length).toBeGreaterThanOrEqual(1);
    expect(includes.length).toBeGreaterThanOrEqual(1);
    expect(mixins[0].name).toContain('flex-center');
    expect(includes[0].name).toContain('flex-center');
  });

  it('extracts SCSS @extend', async () => {
    const parser = await getParser(),
      scss = `.error {\n  border: 1px red;\n}\n.critical {\n  @extend .error;\n}`,
      symbols = parser.parseContent('test.scss', scss),
      extends_ = symbols.filter((s) => s.kind === 'extend');
    expect(extends_.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts SCSS @use and @forward', async () => {
    const parser = await getParser(),
      scss = `@use 'sass:math';\n@forward 'variables';`,
      symbols = parser.parseContent('test.scss', scss),
      imports = symbols.filter((s) => s.kind === 'import');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for empty CSS', async () => {
    const parser = await getParser(),
      symbols = parser.parseContent('test.css', '');
    expect(symbols).toEqual([]);
  });
});
