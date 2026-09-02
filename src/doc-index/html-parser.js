const path = require('path'), { hashContent } = require('../../utils'), { classifyRole } = require('./markdown-parser'),
  HTML_ROLE_PATTERNS = [
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
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlSections(content, filePath) {
  const sections = [],
    hasHeadings = /<h[1-6][\s>]/i.test(content);

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

  {
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

  {
const title = extractTitle(content) || path.basename(filePath);

  if (headingRanges[0].start > 0) {
    const preamble = content.slice(0, headingRanges[0].start),
      textContent = stripHtmlTags(preamble);
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
    const heading = headingRanges[i],
      nextStart = i + 1 < headingRanges.length ? headingRanges[i + 1].start : content.length,
      sectionContent = content.slice(heading.end, nextStart),
      textContent = stripHtmlTags(sectionContent);
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
}
}

function findHeadings(content) {
  const headings = [],
    re = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(content)) !== null) {
    const level = parseInt(match[1], 10),
      text = match[3],
      start = match.index,
      end = start + match[0].length;
    headings.push({ level, text, start, end });
  }
  return headings;
}

function extractTitle(content) {
  const match = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    return stripHtmlTags(match[1]).trim();
  }
  {
const h1 = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    return stripHtmlTags(h1[1]).trim();
  }
  return null;
}
}

function extractHtmlTags(content) {
  const tags = new Set(),
    classRe = /\bclass\s*=\s*["']([^"']+)["']/gi;
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
  {
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
}

function extractHtmlLinks(content) {
  const links = [],
    seen = new Set(),
    re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(content)) !== null) {
    const href = match[1],
      text = stripHtmlTags(match[2]).trim(),
      key = `${href}:${text}`;
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
