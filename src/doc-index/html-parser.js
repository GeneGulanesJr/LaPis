const path = require('path');
const { hashContent } = require('../../utils');
const { classifyRole } = require('./markdown-parser');

const HTML_ROLE_PATTERNS = [
  { pattern: /navigation|sidebar|menu/i, role: 'navigation' },
  { pattern: /landing|hero|banner|jumbotron/i, role: 'landing' },
];

function classifyHtmlRole(title, content, classAttrs) {
  const text = `${title} ${(content || '').slice(0, 200)} ${(classAttrs || '').slice(0, 100)}`;
  for (const { pattern, role } of HTML_ROLE_PATTERNS) {
    if (pattern.test(text)) {
      return role;
    }
  }
  return classifyRole(title, content);
}

function stripHtmlTags(html) {
  let s = String(html || '');
  // Strip real markup (tags, closed script/style blocks) from the raw HTML.
  // codeql[js/incomplete-multi-character-sanitization] Input is untrusted by
  // design; the returned text is hard-stripped again below, so no
  // <script>/<style> sequence can survive in the output.
  s = s
    .replace(/<script[\s\S]*?<\/script(?:\s+[^>]*)?>/gi, '')
    .replace(/<style[\s\S]*?<\/style(?:\s+[^>]*)?>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  // Decode entities, re-stripping any script/style markup the decoding
  // re-introduces, until stable. This keeps encoded payloads such as
  // "&lt;script&gt;alert(1)&lt;/script&gt;" or double-encoded
  // "&amp;lt;script&amp;gt;" from surviving as live <script>/<style> text,
  // while other decoded pseudo-tags (e.g. "&lt;test&gt;") stay as display text.
  let prev;
  do {
    prev = s;
    // codeql[js/double-escaping] Decoding entities is this function's purpose; the output is plain display text and is never re-inserted into HTML.
    s = s
      .replace(/<script[\s\S]*?<\/script(?:\s+[^>]*)?>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style(?:\s+[^>]*)?>/gi, ' ')
      .replace(/<\/?script(?:\s[^>]*)?>/gi, ' ')
      .replace(/<\/?style(?:\s[^>]*)?>/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, '')
      .replace(/&\w+;/g, '');
  } while (s !== prev);
  // Hard guarantee for scanners: no script/style markup survives in the
  // output, whatever the fixpoint loop did above (CodeQL #43/#44).
  s = s.replace(/<\s*\/?\s*script\b[^>]*(>)?/gi, ' ').replace(/<\s*\/?\s*style\b[^>]*(>)?/gi, ' ');
  // Unterminated "<script"/"<style" (no closing '>') is not real markup, but
  // never let the bare sequence survive either.
  s = s.replace(/<(?=\/?script|\/?style)/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function extractHtmlSections(content, filePath) {
  const sections = [];
  const hasHeadings = /<h[1-6][\s>]/i.test(content);

  if (!hasHeadings) {
    const textContent = stripHtmlTags(content);
    sections.push({
      title: extractTitle(content) || path.basename(filePath),
      level: 0,
      content: textContent,
      byte_start: 0,
      byte_end: content.length,
      role: classifyHtmlRole(path.basename(filePath), textContent, ''),
      tags: extractHtmlTags(content),
      content_hash: hashContent(textContent),
    });
    return sections;
  }

  const headingRanges = findHeadings(content);
  if (headingRanges.length === 0) {
    const textContent = stripHtmlTags(content);
    sections.push({
      title: extractTitle(content) || path.basename(filePath),
      level: 0,
      content: textContent,
      byte_start: 0,
      byte_end: content.length,
      role: 'other',
      tags: '',
      content_hash: hashContent(textContent),
    });
    return sections;
  }

  const title = extractTitle(content) || path.basename(filePath);

  if (headingRanges[0].start > 0) {
    const preamble = content.slice(0, headingRanges[0].start);
    const textContent = stripHtmlTags(preamble);
    if (textContent.trim()) {
      sections.push({
        title,
        level: 0,
        content: textContent,
        byte_start: 0,
        byte_end: headingRanges[0].start,
        role: classifyHtmlRole(title, textContent, ''),
        tags: extractHtmlTags(preamble),
        content_hash: hashContent(textContent),
      });
    }
  }

  for (let i = 0; i < headingRanges.length; i++) {
    const heading = headingRanges[i];
    const nextStart = i + 1 < headingRanges.length ? headingRanges[i + 1].start : content.length;
    const sectionContent = content.slice(heading.end, nextStart);
    const textContent = stripHtmlTags(sectionContent);
    sections.push({
      title: stripHtmlTags(heading.text),
      level: heading.level,
      content: textContent,
      byte_start: heading.start,
      byte_end: nextStart,
      role: classifyHtmlRole(heading.text, textContent, ''),
      tags: extractHtmlTags(sectionContent),
      content_hash: hashContent(textContent),
    });
  }

  return sections;
}

function findHeadings(content) {
  const headings = [];
  const re = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(content)) !== null) {
    const level = parseInt(match[1], 10);
    const text = match[3];
    const start = match.index;
    const end = start + match[0].length;
    headings.push({ level, text, start, end });
  }
  return headings;
}

function extractTitle(content) {
  const match = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    return stripHtmlTags(match[1]).trim();
  }
  const h1 = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    return stripHtmlTags(h1[1]).trim();
  }
  return null;
}

function extractHtmlTags(content) {
  const tags = new Set();
  const classRe = /\bclass\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = classRe.exec(content)) !== null) {
    for (const cls of match[1].split(/\s+/)) {
      if (
        cls &&
        !/^(col-|row|container|flex|grid|p-|m-|text-|bg-|border|rounded|shadow|w-|h-|d-|justify|align|overflow|position)/.test(
          cls,
        )
      ) {
        tags.add(cls.toLowerCase());
      }
    }
  }
  const metaKeywords = content.match(/<meta\s+name\s*=\s*["']keywords["']\s+content\s*=\s*["']([^"']+)["']/i);
  if (metaKeywords) {
    for (const kw of metaKeywords[1].split(/[,;]/)) {
      const t = kw.trim().toLowerCase().replace(/\s+/g, '-');
      if (t) {
        tags.add(t);
      }
    }
  }
  return [...tags].join(',');
}

function extractHtmlLinks(content) {
  const links = [];
  const seen = new Set();
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(content)) !== null) {
    const href = match[1];
    const text = stripHtmlTags(match[2]).trim();
    const key = `${href}:${text}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({ href, text });
    }
  }
  return links;
}

module.exports = {
  extractHtmlSections,
  extractTitle,
  extractHtmlLinks,
  stripHtmlTags,
};
