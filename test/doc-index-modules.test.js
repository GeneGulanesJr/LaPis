const markdownParser = require('../src/doc-index/markdown-parser'),
  htmlParser = require('../src/doc-index/html-parser'),
  links = require('../src/doc-index/links'),
  glossary = require('../src/doc-index/glossary'),
  examples = require('../src/doc-index/examples'),
  analytics = require('../src/doc-index/analytics'),
  repos = require('../src/doc-index/repos');

describe('doc-index focused modules', () => {
  it('parses markdown sections through the parser module', () => {
    const sections = markdownParser.parseMarkdownSections('# API Reference\n\nUse #docs here.', '/tmp/api.md');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: 'API Reference', level: 1, role: 'api' });
    expect(sections[0].tags).toBe('docs');
  });

  it('extracts internal links and ignores images/code links', () => {
    const found = links.extractLinks(
      '[Intro](./intro.md) ![Logo](./logo.png) `see [x](bad.md)`\n```md\n[Nope](hidden.md)\n```\n[Site](https://example.com)',
    );
    expect(found).toEqual([
      { target_path: './intro.md', link_text: 'Intro', is_internal: true },
      { target_path: 'https://example.com', link_text: 'Site', is_internal: false },
    ]);
  });

  it('extracts glossary terms from definition-style bold text', () => {
    expect(glossary.extractGlossaryTerms('**Index** — A searchable documentation corpus.')).toEqual([
      { term: 'index', definition: 'A searchable documentation corpus.' },
    ]);
  });

  it('extracts fenced code examples with byte offsets that include language identifiers', () => {
    const blocks = examples.extractCodeBlocks('Before\n```js\nconsole.log("ok");\n```', 10);
    expect(blocks).toEqual([{ lang: 'js', content: 'console.log("ok");', byte_start: 17, byte_end: 45 }]);
  });

  it('extracts fenced code examples with byte offsets when the fence has no language', () => {
    const blocks = examples.extractCodeBlocks('Before\n```\nok\n```', 10);
    expect(blocks).toEqual([{ lang: '', content: 'ok', byte_start: 17, byte_end: 27 }]);
  });

  it('computes search answerability without a per-result content lookup', () => {
    const preparedSql = [],
      db = {
        prepare(sql) {
          preparedSql.push(sql);
          if (sql.includes('SELECT content FROM doc_sections')) {
            throw new Error('N+1 content lookup should not be used');
          }
          return {
            all() {
              return [
                {
                  id: 1,
                  title: 'Quickstart',
                  level: 2,
                  role: 'tutorial',
                  tags: '',
                  content: 'Install and run.```js\nstart();\n```',
                  content_hash: 'abc',
                  file_path: 'README.md',
                  content_length: 32,
                },
              ];
            },
          };
        },
      },
      result = analytics.searchDocs(db, 1, 'start');

    expect(preparedSql).toHaveLength(1);
    expect(preparedSql[0]).toContain('ds.content');
    expect(result.results[0].answerability).toBeGreaterThan(0);
    expect(result.results[0].content).toBeUndefined();
  });

  it('warns and returns structured diagnostics when a doc file cannot be read during a batch', async () => {
    const originalWarn = console.warn,
      warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      const result = await repos.readDocBatch(['/tmp/lapis-missing-doc-file.md']);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('/tmp/lapis-missing-doc-file.md');
      expect(result[0].error).toContain('ENOENT');
      expect(warnings[0]).toContain('Skipping unreadable doc file /tmp/lapis-missing-doc-file.md');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('computes doc coverage from a narrow symbol lookup result', () => {
    const report = analytics.getDocCoverageReport(
      [
        { id: 1, name: 'indexDocs', kind: 'function', file_path: 'doc-index.js' },
        { id: 2, name: 'missing_symbol', kind: 'function', file_path: 'x.js' },
      ],
      [{ id: 10, title: 'indexDocs', content: 'Call indexDocs(path).', role: 'api' }],
    );
    expect(report.coverage_pct).toBe(50);
    expect(report.documented_list).toHaveLength(1);
    expect(report.undocumented_list).toHaveLength(1);
  });
});

describe('html-parser module', () => {
  it('extracts sections from HTML headings', () => {
    const html = `<html><body><h1>Title</h1><p>Intro</p><h2>Section A</h2><p>Content A</p><h3>Sub</h3><p>Detail</p></body></html>`,
      sections = htmlParser.extractHtmlSections(html, 'test.html');
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.some((s) => s.title === 'Title' && s.level === 1)).toBe(true);
    expect(sections.some((s) => s.title === 'Section A' && s.level === 2)).toBe(true);
    expect(sections.some((s) => s.title === 'Sub' && s.level === 3)).toBe(true);
  });

  it('creates a single section for HTML without headings', () => {
    const html = `<html><body><p>Just a paragraph.</p></body></html>`,
      sections = htmlParser.extractHtmlSections(html, 'test.html');
    expect(sections).toHaveLength(1);
    expect(sections[0].level).toBe(0);
    expect(sections[0].content).toContain('Just a paragraph');
  });

  it('uses <title> as the file title', () => {
    const html = `<html><head><title>My Page</title></head><body><p>Content</p></body></html>`,
      sections = htmlParser.extractHtmlSections(html, 'test.html');
    expect(sections[0].title).toBe('My Page');
  });

  it('strips HTML tags from section content', () => {
    const html = `<h1>Heading</h1><p>Hello <strong>world</strong> and <em>more</em></p>`,
      sections = htmlParser.extractHtmlSections(html, 'test.html'),
      content = sections.find((s) => s.level > 0);
    expect(content.content).toContain('Hello world and more');
    expect(content.content).not.toContain('<strong>');
    expect(content.content).not.toContain('<em>');
  });

  it('computes byte offsets for sections', () => {
    const html = `<h1>Title</h1><p>Intro</p><h2>Next</h2><p>More</p>`,
      sections = htmlParser.extractHtmlSections(html, 'test.html');
    for (const sec of sections) {
      expect(sec.byte_start).toBeGreaterThanOrEqual(0);
      expect(sec.byte_end).toBeGreaterThanOrEqual(sec.byte_start);
      expect(sec.content_hash).toBeTruthy();
    }
  });

  it('classifies HTML-specific roles', () => {
    const navHtml = `<h1>Navigation Menu</h1><nav><a href="/">Home</a></nav>`,
      sections = htmlParser.extractHtmlSections(navHtml, 'test.html');
    expect(sections.some((s) => s.role === 'navigation')).toBe(true);
  });

  it('extracts links from HTML content', () => {
    const html = `<a href="/about">About Us</a><a href="/contact">Contact</a><a href="/about">About Us</a>`,
      htmlLinks = htmlParser.extractHtmlLinks(html);
    expect(htmlLinks).toHaveLength(2);
    expect(htmlLinks[0]).toEqual({ href: '/about', text: 'About Us' });
    expect(htmlLinks[1]).toEqual({ href: '/contact', text: 'Contact' });
  });

  it('extracts title from <title> tag', () => {
    expect(htmlParser.extractTitle('<head><title>Test Page</title></head>')).toBe('Test Page');
    expect(htmlParser.extractTitle('<h1>Fallback</h1>')).toBe('Fallback');
    expect(htmlParser.extractTitle('<p>Nothing</p>')).toBeNull();
  });

  it('strips HTML entities from text', () => {
    expect(htmlParser.stripHtmlTags('<p>Hello &amp; world &lt;test&gt;</p>')).toBe('Hello & world <test>');
  });
});
