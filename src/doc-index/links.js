const { slugify } = require('./markdown-parser');

function extractLinks(content) {
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, ''),
    links = [],
    re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    const prefix = stripped.substring(Math.max(0, match.index - 1), match.index),
      target = match[2];
    if (prefix === '!') {
      // oxlint-disable-next-line no-continue
      continue;
    }

    if (
      !target ||
      target.startsWith('[^') ||
      (target.startsWith('http') === false && /[^\w/.\-#_~]/.test(target.replace(/\#.*/, '')))
    ) {
      if (
        !target.startsWith('/') &&
        !target.startsWith('./') &&
        !target.startsWith('../') &&
        !target.startsWith('#') &&
        !target.startsWith('http')
      ) {
        // oxlint-disable-next-line no-continue
        continue;
      }
    }
    links.push({ target_path: target, link_text: match[1], is_internal: isInternalLink(target) });
  }
  return links;
}

function isInternalLink(href) {
  if (!href) {
    return false;
  }
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
    return false;
  }
  return href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || href.startsWith('#');
}

function resolveLinks(db, repoId) {
  let resolved = 0,
    broken = 0;

  const allLinks = db
      .prepare(`
    SELECT dl.id, dl.source_section_id, dl.target_path, ds.file_id, df.path as file_path
    FROM doc_links dl JOIN doc_sections ds ON ds.id = dl.source_section_id
    JOIN doc_files df ON df.id = ds.file_id
    WHERE ds.repo_id = ? AND dl.is_broken = 0
  `)
      .all(repoId),
    allSections = db.prepare('SELECT id, file_id, title FROM doc_sections WHERE repo_id = ?').all(repoId),
    sectionsByFile = new Map(),
    sectionSlugCache = new Map();
  for (const s of allSections) {
    if (!sectionsByFile.has(s.file_id)) {
      sectionsByFile.set(s.file_id, []);
    }
    sectionsByFile.get(s.file_id).push(s);
    sectionSlugCache.set(s.id, slugify(s.title));
  }

  {
    const allDocFiles = db.prepare('SELECT id, path FROM doc_files WHERE repo_id = ?').all(repoId),
      docFileByPath = new Map();
    for (const f of allDocFiles) {
      docFileByPath.set(f.path, f);
      const short = f.path.split('/').pop();
      if (short && !docFileByPath.has(short)) {
        docFileByPath.set(short, f);
      }
    }

    {
      const updateStmt = db.prepare('UPDATE doc_links SET target_section_id = ? WHERE id = ?'),
        breakStmt = db.prepare('UPDATE doc_links SET is_broken = 1 WHERE id = ?'),
        firstSectionStmt = db.prepare('SELECT id FROM doc_sections WHERE file_id = ? LIMIT 1');

      for (const link of allLinks) {
        let targetSectionId = null;
        const href = link.target_path;

        if (href.startsWith('#')) {
          targetSectionId = resolveAnchor(link.file_id, href.slice(1));
        } else {
          const [pathPartRaw, anchor] = href.split('#'),
            pathPart = pathPartRaw.replace(/^\.\/|^\.\.\//, '');

          let docFile = findFileByPath(pathPart);
          if (!docFile && !pathPart.endsWith('.md') && !pathPart.endsWith('.mdx')) {
            docFile = findFileByPath(`${pathPart}.md`);
          }

          if (docFile) {
            targetSectionId = anchor ? resolveAnchor(docFile.id, anchor) : firstSectionStmt.get(docFile.id)?.id || null;
          }
        }

        if (targetSectionId) {
          updateStmt.run(targetSectionId, link.id);
          resolved++;
        } else {
          breakStmt.run(link.id);
          broken++;
        }
      }

      return { resolved, broken };
      function findFileByPath(pathPart) {
        if (docFileByPath.has(pathPart)) {
          return docFileByPath.get(pathPart);
        }
        for (const f of allDocFiles) {
          if (f.path.endsWith(`/${pathPart}`) || f.path === pathPart) {
            return f;
          }
        }
        return null;
      }
      function resolveAnchor(fileId, anchor) {
        const slug = slugify(anchor),
          candidates = sectionsByFile.get(fileId) || [];
        for (const c of candidates) {
          const cSlug = sectionSlugCache.get(c.id);
          if (cSlug === slug || cSlug.startsWith(slug) || slug.startsWith(cSlug)) {
            return c.id;
          }
        }
        return null;
      }
    }
  }
}

function getBacklinks(db, repoId, docPath) {
  const targetFile = db
    .prepare('SELECT id FROM doc_files WHERE repo_id = ? AND path LIKE ?')
    .get(repoId, `%${docPath}%`);
  if (!targetFile) {
    return { error: `Doc file not found: ${docPath}` };
  }
  {
    const targetSections = db.prepare('SELECT id FROM doc_sections WHERE file_id = ?').all(targetFile.id),
      targetIds = targetSections.map((s) => s.id);
    if (!targetIds.length) {
      return { backlinks: [] };
    }

    {
      const placeholders = targetIds.map(() => '?').join(','),
        backlinks = db
          .prepare(`
    SELECT dl.target_path, dl.link_text, ds.title as source_title, df.path as source_file
    FROM doc_links dl JOIN doc_sections ds ON ds.id = dl.source_section_id JOIN doc_files df ON df.id = ds.file_id
    WHERE dl.target_section_id IN (${placeholders}) AND dl.is_broken = 0
  `)
          .all(...targetIds);
      return { backlinks };
    }
  }
}

function getBrokenLinks(db, repoId) {
  return db
    .prepare(`
    SELECT dl.target_path, dl.link_text, ds.title as source_title, df.path as source_file
    FROM doc_links dl JOIN doc_sections ds ON ds.id = dl.source_section_id JOIN doc_files df ON df.id = ds.file_id
    WHERE dl.is_broken = 1 AND ds.repo_id = ? ORDER BY df.path
  `)
    .all(repoId);
}

module.exports = { extractLinks, isInternalLink, resolveLinks, getBacklinks, getBrokenLinks };
