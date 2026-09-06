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
  // Single-pass, regex-free text extraction (CodeQL js/double-escaping and
  // js/incomplete-multi-character-sanitization are raised by the .replace()
  // sanitize/unescape chains this replaces):
  //   1. Drop markup: "<" opens a tag; script/style elements are dropped
  //      INCLUDING their content, every other tag is replaced by a space.
  //   2. Decode entities: "&" starts an entity only when a ';' follows
  //      within 10 characters; unknown names decode to "" (matching the
  //      old `.replace(/&\w+;/g, '')`), other stray "&" stay literal.
  //   3. Final scrub: no literal <script / </script / <style / </style
  //      sequence can survive in the output, whatever the input was.
  const src = String(html || '');
  const lower = src.toLowerCase();
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };
  let out = '';
  let i = 0;

  const decodeEntityAt = (idx) => {
    const semi = src.indexOf(';', idx + 1);
    if (semi === -1 || semi - idx > 10) {
      return null;
    }
    const body = src.slice(idx + 1, semi);
    if (Object.prototype.hasOwnProperty.call(entities, body)) {
      return [entities[body], semi + 1];
    }
    if (/^#\\d{1,7}$/.test(body)) {
      const code = Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? [String.fromCodePoint(code), semi + 1] : ['', semi + 1];
    }
    if (/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(body)) {
      return ['', semi + 1]; // unknown named entity: dropped, as before
    }
    return null;
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '<') {
      const gt = src.indexOf('>', i);
      const rawTag = (gt === -1 ? lower.slice(i + 1) : lower.slice(i + 1, gt)).trim();
      const isBlock =
        rawTag === 'script' || rawTag.startsWith('script ') || rawTag === 'style' || rawTag.startsWith('style ');
      if (gt === -1) {
        // Unterminated tag: keep as text unless it opens script/style —
        // nothing after it can close such an element, so drop the residue.
        if (!isBlock) {
          out += src.slice(i);
        }
        i = src.length;
        continue;
      }
      if (isBlock) {
        // Drop the whole element including its content.
        const name = rawTag.split(/[\s/]/)[0];
        const close = lower.indexOf('</' + name, gt);
        i = close === -1 ? src.length : lower.indexOf('>', close) + 1 || src.length;
        out += ' ';
        continue;
      }
      out += ' ';
      i = gt + 1;
      continue;
    }

    if (ch === '&') {
      const decoded = decodeEntityAt(i);
      if (decoded) {
        out += decoded[0];
        i = decoded[1];
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  // Final scrub: remove any literal <script / </script / <style / </style
  // sequence (case-insensitive) that entity decoding produced, through its
  // closing '>' when present. Linear, regex-free.
  let scrubbed = '';
  let j = 0;
  const n = out.length;
  const lowerOut = out.toLowerCase();
  while (j < n) {
    if (out[j] === '<') {
      let k = j + 1;
      if (lowerOut[k] === '/') {
        k += 1;
      }
      const word = lowerOut.slice(k, k + 6);
      if (word.startsWith('script') || word.startsWith('style')) {
        while (k < n && lowerOut[k] !== '>' && lowerOut[k] !== '<') {
          k += 1;
        }
        if (lowerOut[k] === '>') {
          k += 1;
        }
        scrubbed += ' ';
        j = k;
        continue;
      }
    }
    scrubbed += out[j];
    j += 1;
  }

  return scrubbed.replace(/\s+/g, ' ').trim();
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
