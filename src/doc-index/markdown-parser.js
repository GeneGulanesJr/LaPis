const path = require('path'), { hashContent } = require('../../utils'), ROLE_PATTERNS = [
  { pattern: /tutorial|getting.?started|quickstart|walkthrough/i, role: 'tutorial' },
  { pattern: /api|reference|endpoint|method/i, role: 'api' },
  { pattern: /how.?to|guide|cookbook/i, role: 'how_to' },
  { pattern: /concept|overview|architecture|design|philosophy/i, role: 'concept' },
  { pattern: /troubleshoot|debug|fix|common.?error|pitfall/i, role: 'troubleshooting' },
  { pattern: /changelog|release|history|what.?new/i, role: 'changelog' },
  { pattern: /faq|q&a|frequently/i, role: 'faq' },
  { pattern: /example|demo|sample|snippet/i, role: 'example' },
];


function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}



function classifyRole(title, content) {
  const text = `${title} ${(content || '').slice(0, 200)}`;
  for (const { pattern, role } of ROLE_PATTERNS) {
    if (pattern.test(text)) {
      return role;
    }
  }
  return 'other';
}

function extractTags(content) {
  const tags = new Set(),
    re = /(?<!#)#(\w{2,})/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    tags.add(match[1].toLowerCase());
  }
  return [...tags].join(',');
}

function finalizeSection(section, lines, endLine, lineByteOffsets) {
  section.content = lines.slice(section._startLine, endLine).join('\n').trim();
  section.byte_end = lineByteOffsets[endLine];
  section.content_hash = hashContent(section.content);
  section.role = classifyRole(section.title, section.content);
  section.tags = extractTags(section.content);
  delete section._startLine;
  return section;
}

function parseMarkdownSections(content, filePath) {
  const sections = [],
    lines = content.split('\n'),
    lineByteOffsets = [0];
  for (let l = 0; l < lines.length; l++) {
    lineByteOffsets.push(lineByteOffsets[l] + lines[l].length + 1);
  }

  let i = 0, currentSection = null,
    hasHeadings = false;
  if (lines[0] && lines[0].trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') {
      i++;
    }
    i++;
  }

  

  while (i < lines.length) {
    const line = lines[i],
      atxMatch = line.match(/^(#{1,6})\s+(.+)$/),
      setextMatch = i + 1 < lines.length && (lines[i + 1].match(/^={3,}\s*$/) || lines[i + 1].match(/^-{3,}\s*$/));

    if (atxMatch) {
      hasHeadings = true;
      if (currentSection) {
        sections.push(finalizeSection(currentSection, lines, i, lineByteOffsets));
      }
      currentSection = {
        title: atxMatch[2].replace(/\s*#+\s*$/, '').trim(),
        level: atxMatch[1].length,
        content: '',
        byte_start: lineByteOffsets[i],
        byte_end: 0,
        _startLine: i + 1,
        role: 'other',
        tags: '',
        content_hash: '',
      };
      i++;
      // oxlint-disable-next-line no-continue
      continue;
    }

    if (setextMatch) {
      hasHeadings = true;
      if (currentSection) {
        sections.push(finalizeSection(currentSection, lines, i, lineByteOffsets));
      }
      currentSection = {
        title: line.trim(),
        level: lines[i + 1].includes('=') ? 1 : 2,
        content: '',
        byte_start: lineByteOffsets[i],
        byte_end: 0,
        _startLine: i + 2,
        role: 'other',
        tags: '',
        content_hash: '',
      };
      i += 2;
      // oxlint-disable-next-line no-continue
      continue;
    }

    i++;
  }

  if (currentSection) {
    sections.push(finalizeSection(currentSection, lines, i, lineByteOffsets));
  }

  if (!hasHeadings) {
    sections.push({
      title: path.basename(filePath),
      level: 0,
      content: content.trim(),
      byte_start: 0,
      byte_end: content.length,
      role: 'other',
      tags: extractTags(content),
      content_hash: hashContent(content),
    });
  }

  return sections;
}

module.exports = { slugify, classifyRole, extractTags, parseMarkdownSections };
