const fs = require('fs'), path = require('path'), { RESULT_LIMITS } = require('../../constants'), { hashContent, walkDirForDocs: walkDir } = require('../../utils'), { parseMarkdownSections } = require('./markdown-parser'), { extractHtmlSections, extractHtmlLinks: parseHtmlLinks } = require('./html-parser'), { buildSectionHierarchy } = require('./sections'), { extractLinks, resolveLinks } = require('./links'), { extractGlossaryTerms } = require('./glossary'), { extractCodeBlocks } = require('./examples');










function clearRepo(db, repoId) {
  db.prepare('DELETE FROM doc_code_blocks WHERE section_id IN (SELECT id FROM doc_sections WHERE repo_id = ?)').run(
    repoId,
  );
  db.prepare('DELETE FROM doc_links WHERE source_section_id IN (SELECT id FROM doc_sections WHERE repo_id = ?)').run(
    repoId,
  );
  db.prepare('DELETE FROM doc_terms WHERE repo_id = ?').run(repoId);
  db.prepare('DELETE FROM doc_sections WHERE repo_id = ?').run(repoId);
  db.prepare('DELETE FROM doc_files WHERE repo_id = ?').run(repoId);
}

function upsertDocRepo(db, rootPath, repoName) {
  const existingByName = db.prepare('SELECT id FROM doc_repos WHERE name = ?').get(repoName),
    existingByPath = db.prepare('SELECT id FROM doc_repos WHERE path = ?').get(rootPath);
  if (existingByName) {
    if (existingByName.id !== existingByPath?.id) {
      db.prepare('UPDATE doc_repos SET path = ? WHERE id = ?').run(rootPath, existingByName.id);
    }
    clearRepo(db, existingByName.id);
    return existingByName.id;
  }
  if (existingByPath) {
    db.prepare('UPDATE doc_repos SET name = ? WHERE id = ?').run(repoName, existingByPath.id);
    clearRepo(db, existingByPath.id);
    return existingByPath.id;
  }
  return db.prepare('INSERT INTO doc_repos (name, path) VALUES (?, ?) RETURNING id').get(repoName, rootPath).id;
}

async function readDocBatch(files) {
  return Promise.all(
    files.map(async (fp) => {
      try {
        const [content, stat] = await Promise.all([fs.promises.readFile(fp, 'utf-8'), fs.promises.stat(fp)]);
        return { filePath: fp, content, stat };
      } catch (e) {
        const warning = { filePath: fp, error: e.message };
        console.warn(`[doc-index] Skipping unreadable doc file ${fp}: ${e.message}`);
        return warning;
      }
    }),
  );
}

async function indexDocs(db, rootPath, repoName, ignoreGlob) {
  if (!fs.existsSync(rootPath)) {
    return { error: `Path not found: ${rootPath}` };
  }

  const repoId = upsertDocRepo(db, rootPath, repoName),
    files = walkDir(rootPath, ignoreGlob);
  let totalSections = 0,
    totalLinks = 0,
    totalTerms = 0,
    totalCodeBlocks = 0;
  {
const warnings = [],
    insertFile = db.prepare(
      'INSERT INTO doc_files (repo_id, path, content, content_hash, mtime) VALUES (?, ?, ?, ?, ?) RETURNING id',
    ),
    insertSection = db.prepare(
      'INSERT INTO doc_sections (repo_id, file_id, title, level, parent_id, content, content_hash, byte_start, byte_end, role, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    ),
    insertLink = db.prepare(
      'INSERT INTO doc_links (source_section_id, target_path, target_section_id, link_text, is_broken) VALUES (?, ?, ?, ?, ?)',
    ),
    insertTerm = db.prepare(
      'INSERT OR IGNORE INTO doc_terms (repo_id, term, definition, section_id) VALUES (?, ?, ?, ?)',
    ),
    insertCodeBlock = db.prepare(
      'INSERT INTO doc_code_blocks (section_id, lang, content, byte_start, byte_end) VALUES (?, ?, ?, ?, ?)',
    ),
    useTx =
      typeof db.transaction === 'function'
        ? (fn) => db.transaction(fn)()
        : (fn) => {
            db.exec('BEGIN');
            try {
              const result = fn();
              db.exec('COMMIT');
              return result;
            } catch (e) {
              try {
                db.exec('ROLLBACK');
              } catch {}
              throw e;
            }
          },
    BATCH_SIZE = RESULT_LIMITS.DOC_BATCH_SIZE;

  function processEntry(entry) {
    const { filePath, content, stat } = entry,
      relPath = path.relative(rootPath, filePath),
      fileId = insertFile.get(repoId, relPath, content, hashContent(content), stat.mtimeMs).id,
      ext = path.extname(filePath).toLowerCase(),
      isHtml = ext === '.html' || ext === '.htm',
      rawSections = isHtml ? extractHtmlSections(content, filePath) : parseMarkdownSections(content, filePath),
      withParent = buildSectionHierarchy(rawSections),
      sectionIdMap = new Map();

    for (let idx = 0; idx < withParent.length; idx++) {
      const sec = withParent[idx],
        parentId = sec.parent_idx !== null ? sectionIdMap.get(sec.parent_idx) || null : null,
        sectionDbId = insertSection.get(
          repoId,
          fileId,
          sec.title,
          sec.level,
          parentId,
          sec.content,
          sec.content_hash,
          sec.byte_start,
          sec.byte_end,
          sec.role,
          sec.tags,
        ).id;
      sectionIdMap.set(idx, sectionDbId);
      totalSections++;

      if (isHtml) {
        const rawHtmlSlice = content.slice(sec.byte_start, sec.byte_end);
        for (const link of parseHtmlLinks(rawHtmlSlice)) {
          insertLink.run(sectionDbId, link.href, null, link.text, 0);
          totalLinks++;
        }
      } else {
        for (const link of extractLinks(sec.content)) {
          if (link.is_internal) {
            insertLink.run(sectionDbId, link.target_path, null, link.link_text, 0);
            totalLinks++;
          }
        }
      }

      if (!isHtml) {
        for (const term of extractGlossaryTerms(sec.content)) {
          insertTerm.run(repoId, term.term, term.definition, sectionDbId);
          totalTerms++;
        }

        for (const block of extractCodeBlocks(sec.content, sec.byte_start)) {
          insertCodeBlock.run(sectionDbId, block.lang, block.content, block.byte_start, block.byte_end);
          totalCodeBlocks++;
        }
      }
    }
  }

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    // oxlint-disable-next-line no-await-in-loop
    const reads = await readDocBatch(files.slice(i, i + BATCH_SIZE));

    useTx(() => {
      for (const entry of reads) {
        if (entry.error) {
          warnings.push({ path: path.relative(rootPath, entry.filePath), error: entry.error });
        } else {
          processEntry(entry);
        }
      }
    });
  }

  {
const linkResults = resolveLinks(db, repoId);
  db.prepare("UPDATE doc_repos SET file_count = ?, section_count = ?, updated_at = datetime('now') WHERE id = ?").run(
    files.length,
    totalSections,
    repoId,
  );

  return {
    success: true,
    repo: repoName,
    files: files.length,
    sections: totalSections,
    links: totalLinks,
    terms: totalTerms,
    code_blocks: totalCodeBlocks,
    skipped_files: warnings.length,
    warnings,
    link_resolution: linkResults,
  };
}
}
}

async function reindexDocs(db, repoId, mode, ignoreGlob) {
  const repo = db.prepare('SELECT id, name, path FROM doc_repos WHERE id = ?').get(repoId);
  if (!repo) {
    return { error: `Repo ${repoId} not found` };
  }
  return indexDocs(db, repo.path, repo.name, ignoreGlob);
}

module.exports = { indexDocs, reindexDocs, upsertDocRepo, clearRepo, readDocBatch };
