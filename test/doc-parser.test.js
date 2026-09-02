// Unit tests for doc-parser
const docIndexer = require('../src/doc-index'),
  parseSections = docIndexer._parseMarkdownSections,
  slugify = docIndexer._slugify;

describe('doc-parser (markdown internals)', () => {
  describe('_slugify', () => {
    it('should lowercase and hyphenate', () => {
      expect(slugify('Hello World')).toBe('hello-world');
      expect(slugify('What is Pi?')).toBe('what-is-pi');
      expect(slugify('  Spaces  ')).toBe('spaces');
    });

    it('should strip special characters', () => {
      expect(slugify('foo.bar_baz')).toBe('foobar_baz');
      expect(slugify('hello---world')).toBe('hello-world');
      expect(slugify('-trim-')).toBe('trim');
    });
  });

  describe('heading parsing', () => {
    it('should parse single heading', () => {
      const sections = parseSections('# Introduction\n\nSome content here.', '/test/a.md');
      expect(sections.length).toBe(1);
      expect(sections[0].title).toBe('Introduction');
      expect(sections[0].level).toBe(1);
      expect(sections[0].content).toBe('Some content here.');
      expect(sections[0].content_hash).toBeTruthy();
      expect(sections[0].content_hash.length).toBe(16);
    });

    it('should parse multiple headings', () => {
      const md = '# Top\n\nTop content.\n\n## Middle\n\nMiddle content.\n\n### Bottom\n\nBottom content.',
        sections = parseSections(md, '/test/b.md');
      expect(sections.length).toBe(3);
      expect(sections[0].title).toBe('Top');
      expect(sections[1].title).toBe('Middle');
      expect(sections[2].title).toBe('Bottom');
      expect(sections[0].level).toBe(1);
      expect(sections[1].level).toBe(2);
      expect(sections[2].level).toBe(3);
    });

    it('should strip trailing # from headings', () => {
      const sections = parseSections('## My Section ##\n\ncontent', '/test/c.md');
      expect(sections[0].title).toBe('My Section');
    });

    it('should skip YAML frontmatter', () => {
      const md = '---\ntitle: Test\n---\n# Real Heading\n\nReal content.',
        sections = parseSections(md, '/test/d.md');
      expect(sections.length).toBe(1);
      expect(sections[0].title).toBe('Real Heading');
    });

    it('should handle setext headings (underlined)', () => {
      const md = 'Section One\n==========\n\nContent one.\n\nSection Two\n----------\n\nContent two.',
        sections = parseSections(md, '/test/e.md');
      expect(sections.length).toBe(2);
      expect(sections[0].title).toBe('Section One');
      expect(sections[0].level).toBe(1);
      expect(sections[1].title).toBe('Section Two');
      expect(sections[1].level).toBe(2);
    });

    it('should handle headings with inline code', () => {
      const sections = parseSections('### `codeParser.parseFile()`\n\nContent about parsing.', '/test/code.md');
      expect(sections[0].title).toBe('`codeParser.parseFile()`');
      expect(sections[0].level).toBe(3);
    });

    it('should handle deeply nested headings (level 6)', () => {
      const sections = parseSections('###### Very Deep\n\nDeep content.', '/test/deep.md');
      expect(sections[0].level).toBe(6);
      expect(sections[0].title).toBe('Very Deep');
    });
  });

  describe('role classification', () => {
    it('should classify tutorial role', () => {
      const tutorialSections = parseSections('# Quickstart Guide\n\nA tutorial for beginners.', '/test/tut.md');
      expect(tutorialSections[0].role).toBe('tutorial');
    });

    it('should classify api role', () => {
      const apiSections = parseSections('# API Reference\n\nEndpoint documentation.', '/test/api.md');
      expect(apiSections[0].role).toBe('api');
    });

    it('should classify concept role', () => {
      const conceptSections = parseSections('# Architecture Overview\n\nDesign philosophy.', '/test/arch.md');
      expect(conceptSections[0].role).toBe('concept');
    });
  });

  describe('tags and metadata', () => {
    it('should extract tags from content', () => {
      const sections = parseSections('# Tags Test\n\n#javascript #typescript #wasm #parsing', '/test/tags.md');
      expect(sections[0].tags).toContain('javascript');
      expect(sections[0].tags).toContain('typescript');
      expect(sections[0].tags).toContain('wasm');
      expect(sections[0].tags).toContain('parsing');
    });

    it('should include byte offsets', () => {
      const md = '# Title\n\nContent body text.',
        sections = parseSections(md, '/test/bytes.md');
      expect(sections[0].byte_start).toBeGreaterThanOrEqual(0);
      expect(sections[0].byte_end).toBeGreaterThan(sections[0].byte_start);
    });
  });

  describe('content hashing', () => {
    it('should produce consistent content hashes for identical content', () => {
      const s1 = parseSections('# A\n\nsame', '/test/same1.md'),
        s2 = parseSections('# A\n\nsame', '/test/same2.md');
      expect(s1[0].content_hash).toBe(s2[0].content_hash);
    });

    it('should produce different hashes for different content', () => {
      const s1 = parseSections('# A\n\nsame', '/test/diff1.md'),
        s2 = parseSections('# A\n\ndifferent', '/test/diff2.md');
      expect(s1[0].content_hash).not.toBe(s2[0].content_hash);
    });
  });

  describe('edge cases', () => {
    it('should handle heading-less content as a single section', () => {
      const sections = parseSections('Just some text without any headings.', '/test/noh.md');
      expect(sections.length).toBe(1);
      expect(sections[0].level).toBe(0);
      expect(sections[0].title).toBe('noh.md');
      expect(sections[0].content).toBe('Just some text without any headings.');
    });

    it('should handle empty content', () => {
      const sections = parseSections('# Empty\n\n', '/test/empty.md');
      expect(sections.length).toBe(1);
      expect(sections[0].content).toBe('');
      expect(sections[0].content_hash).toBeTruthy();
    });
  });
});
