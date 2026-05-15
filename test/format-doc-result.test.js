import { formatDocResult } from '../extensions/memory-layer/tools/format-doc-result.ts';

describe('tools/format-doc-result', () => {
  describe('search', () => {
    it('should format doc search results', () => {
      const result = formatDocResult('search', {
        results: [
          { role: 'concept', level: 2, title: 'Getting Started', file_path: 'docs/intro.md' },
        ],
      });
      expect(result).toContain('**Doc search:** 1 results');
      expect(result).toContain('[concept]');
      expect(result).toContain('Getting Started');
    });
  });

  describe('outline (tree)', () => {
    it('should format tree outline', () => {
      const result = formatDocResult('outline', [
        { level: 1, title: 'Intro', role: 'concept', children: [
          { level: 2, title: 'Setup', role: 'how_to', children: [] },
        ]},
      ]);
      expect(result).toContain('Intro');
      expect(result).toContain('Setup');
    });
  });

  describe('outline (file list)', () => {
    it('should format file list outline', () => {
      const result = formatDocResult('outline', {
        files: [{ path: 'README.md', section_count: 5 }],
      });
      expect(result).toContain('**Docs:** 1 files');
      expect(result).toContain('README.md');
    });
  });

  describe('backlinks', () => {
    it('should format backlinks', () => {
      const result = formatDocResult('backlinks', {
        backlinks: [{ source_file: 'a.md', source_title: 'Intro', link_text: 'setup' }],
      });
      expect(result).toContain('**Backlinks:** 1');
      expect(result).toContain('a.md#Intro');
    });
  });

  describe('broken-links', () => {
    it('should format broken links', () => {
      const result = formatDocResult('broken-links', {
        broken_links: [{ source_file: 'a.md', link_text: 'missing', target_path: 'gone.md' }],
      });
      expect(result).toContain('**Broken links:** 1');
      expect(result).toContain('gone.md');
    });
  });

  describe('glossary (list)', () => {
    it('should format glossary list', () => {
      const result = formatDocResult('glossary', [
        { term: 'API', definition: 'Application Programming Interface' },
      ]);
      expect(result).toContain('**Glossary:** 1 terms');
      expect(result).toContain('API');
    });
  });

  describe('glossary (single)', () => {
    it('should format single glossary entry', () => {
      const result = formatDocResult('glossary', { term: 'API', definition: 'Application Programming Interface' });
      expect(result).toContain('**API**');
    });
  });

  describe('orphans', () => {
    it('should report no orphans', () => {
      const result = formatDocResult('orphans', { orphans: [], total: 0 });
      expect(result).toContain('No orphan sections found');
    });

    it('should format orphan sections', () => {
      const result = formatDocResult('orphans', {
        total: 1,
        orphans: [{ title: 'Lost Section', level: 2, file_path: 'docs/lost.md', role: 'other' }],
      });
      expect(result).toContain('1 orphan sections');
      expect(result).toContain('Lost Section');
    });
  });

  describe('stale-pages', () => {
    it('should report up-to-date docs', () => {
      const result = formatDocResult('stale-pages', { stale: [], missing: [] });
      expect(result).toContain('No stale or missing pages');
    });
  });

  describe('duplicates', () => {
    it('should report no duplicates', () => {
      const result = formatDocResult('duplicates', { duplicates: [], total_duplicate_groups: 0 });
      expect(result).toContain('No duplicate sections');
    });
  });

  describe('default', () => {
    it('should JSON-stringify unknown modes', () => {
      const result = formatDocResult('unknown-mode', { foo: 'bar' });
      expect(result).toContain('"foo"');
    });
  });
});
