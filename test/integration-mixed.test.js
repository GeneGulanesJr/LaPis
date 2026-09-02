import { afterEach, describe, expect, it } from 'vitest';
const fs = require('fs'), path = require('path'), os = require('os');



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

describe('Mixed file type parsing integration', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('parses JS, CSS, SCSS, and HTML files with appropriate symbols', async () => {
    const parser = await getParser();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-test-'));

    fs.writeFileSync(
      path.join(tmpDir, 'app.js'),
      `
export function init() {
  const mod = import('./utils.js');
  return mod;
}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'style.css'),
      `
:root {
  --primary: #333;
}
.container {
  display: flex;
}
@media (min-width: 768px) {
  .container { max-width: 720px; }
}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'theme.scss'),
      `
$primary: #333;
@mixin flex-center {
  display: flex;
}
.btn {
  @include flex-center;
  @extend .base-btn;
}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      `
<div id="app" class="container">
  <MyComponent>
    <app-header></app-header>
  </MyComponent>
</div>
<script>
  console.log('hello');
</script>
`,
    );

    {
const jsResult = parser.parseContent('app.js', fs.readFileSync(path.join(tmpDir, 'app.js'), 'utf8')),
      cssResult = parser.parseContent('style.css', fs.readFileSync(path.join(tmpDir, 'style.css'), 'utf8')),
      scssResult = parser.parseContent('theme.scss', fs.readFileSync(path.join(tmpDir, 'theme.scss'), 'utf8')),
      htmlResult = parser.parseContent('index.html', fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8'));

    expect(jsResult.map((s) => s.kind)).toContain('dynamic_import');
    expect(cssResult.map((s) => s.kind)).toContain('custom_property');
    expect(cssResult.map((s) => s.kind)).toContain('selector');
    expect(cssResult.map((s) => s.kind)).toContain('media_query');
    expect(scssResult.map((s) => s.kind)).toContain('scss_variable');
    expect(scssResult.map((s) => s.kind)).toContain('mixin');
    expect(scssResult.map((s) => s.kind)).toContain('include');
    expect(scssResult.map((s) => s.kind)).toContain('extend');
    expect(htmlResult.map((s) => s.kind)).toContain('id');
    expect(htmlResult.map((s) => s.kind)).toContain('component');
    expect(htmlResult.map((s) => s.kind)).toContain('script');
  }
});
});
