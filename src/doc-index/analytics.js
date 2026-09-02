const fs = require('fs'),
  path = require('path'),
  { RESULT_LIMITS } = require('../../constants');

function searchDocs(db, repoId, query, opts) {
  opts = opts || {};
  let sql = `SELECT ds.id, ds.title, ds.level, ds.role, ds.tags, ds.content, ds.content_hash, df.path as file_path,
    length(ds.content) as content_length
    FROM doc_sections_fts
    JOIN doc_sections ds ON ds.id = doc_sections_fts.rowid
    JOIN doc_files df ON df.id = ds.file_id
    WHERE doc_sections_fts MATCH ? AND ds.repo_id = ?`;
  const params = [query, repoId];
  if (opts.level) {
    sql += ' AND ds.level = ?';
    params.push(opts.level);
  }
  if (opts.role) {
    sql += ' AND ds.role = ?';
    params.push(opts.role);
  }
  sql += ` ORDER BY rank LIMIT ${RESULT_LIMITS.DOC_SEARCH_LIMIT}`;
  try {
    const results = db.prepare(sql).all(...params);
    for (const r of results) {
      const content = r.content || '',
        hasCode = content.includes('```'),
        codeRatio = (content.match(/```[\s\S]*?```/g) || []).join('').length / Math.max(content.length, 1);
      let roleScore = 0;
      if (r.role === 'how_to' || r.role === 'tutorial') {
        roleScore = 0.3;
      } else if (r.role === 'api' || r.role === 'reference') {
        roleScore = 0.2;
      }
      r.answerability = Math.min(
        1,
        (r.level >= 2 && r.level <= 4 ? 0.3 : 0.1) +
          roleScore +
          (content.length > 100 && content.length < 3000 ? 0.2 : 0.1) +
          (hasCode ? 0.2 : 0) +
          (codeRatio > 0.2 && codeRatio < 0.7 ? 0.1 : 0),
      );
      delete r.content;
      delete r.content_hash;
      delete r.content_length;
    }
    return { results };
  } catch (e) {
    return { error: `Search failed: ${e.message}` };
  }
}

function getTutorialPath(db, repoId, sectionId) {
  const section = db.prepare('SELECT id, title, file_id, content FROM doc_sections WHERE id = ?').get(sectionId);
  if (!section) {
    return { error: `Section ${sectionId} not found` };
  }

  const chain = [{ section_id: section.id, title: section.title }],
    nextMatch = (section.content || '').match(/[Nn]ext:?\s*\[([^\]]+)\]\(([^)]+)\)/),
    file = (() => {
      if (nextMatch) {
        const targetSection = db
          .prepare(`
        SELECT ds.id, ds.title FROM doc_sections ds JOIN doc_files df ON df.id = ds.file_id
        WHERE df.repo_id = ? AND df.path LIKE ? AND ds.level = ? LIMIT 1
      `)
          .get(repoId, `%${nextMatch[2]}%`, section.level);
        if (targetSection) {
          chain.push({ section_id: targetSection.id, title: targetSection.title });
        }
      }

      return db.prepare('SELECT path FROM doc_files WHERE id = ?').get(section.file_id);
    })();
  if (file) {
    const numMatch = file.path.match(/(\d+)-/);
    if (numMatch) {
      const currentNum = parseInt(numMatch[1]),
        files = db.prepare('SELECT path FROM doc_files WHERE repo_id = ? ORDER BY path').all(repoId),
        ordered = files
          .filter((f) => {
            const m = f.path.match(/(\d+)-/);
            return m && parseInt(m[1]) > currentNum;
          })
          .slice(0, 5);
      for (const nextFile of ordered) {
        const nextSection = db
          .prepare(
            'SELECT id, title FROM doc_sections WHERE file_id = (SELECT id FROM doc_files WHERE repo_id = ? AND path = ?) AND level = ? LIMIT 1',
          )
          .get(repoId, nextFile.path, section.level);
        if (nextSection) {
          chain.push({ section_id: nextSection.id, title: nextSection.title });
        }
      }
    }
  }

  return { chain };
}

function getOrphanSections(db, repoId, opts = {}) {
  const includeSameDoc = opts.includeSameDoc || false;

  let query, params;
  if (includeSameDoc) {
    query = `
      SELECT ds.id, ds.title, ds.level, df.path as file_path, ds.role
      FROM doc_sections ds
      JOIN doc_files df ON df.id = ds.file_id
      WHERE ds.repo_id = ?
        AND ds.id NOT IN (SELECT DISTINCT target_section_id FROM doc_links WHERE target_section_id IS NOT NULL)
      ORDER BY ds.level, ds.title
    `;
    params = [repoId];
  } else {
    query = `
      SELECT ds.id, ds.title, ds.level, df.path as file_path, ds.role
      FROM doc_sections ds
      JOIN doc_files df ON df.id = ds.file_id
      WHERE ds.repo_id = ?
        AND ds.id NOT IN (
          SELECT DISTINCT dl.target_section_id
          FROM doc_links dl
          JOIN doc_sections src ON src.id = dl.source_section_id
          WHERE dl.target_section_id IS NOT NULL AND src.file_id != ds.file_id
        )
        AND ds.level > 1
      ORDER BY ds.level, ds.title
    `;
    params = [repoId];
  }

  {
    const orphans = db.prepare(query).all(...params);
    return { orphans, total: orphans.length };
  }
}

function createDbCodeSymbolLookup(db) {
  return Object.freeze({
    listDocumentableSymbols(repoId) {
      return db
        .prepare(`
    SELECT id, name, kind, file_path FROM code_symbols
    WHERE repo_id = ? AND kind IN ('function', 'constant', 'method')
  `)
        .all(repoId);
    },
  });
}

function getDocCoverageReport(symbols, sections) {
  const docNames = new Map();
  for (const s of sections) {
    const lowerTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, ''),
      fnRefs = (() => {
        docNames.set(lowerTitle, s);

        return s.content.match(/\b([a-z_][a-z0-9_]{2,})\s*\(/gi) || [];
      })();
    for (const ref of fnRefs) {
      const name = ref.replace(/\s*\($/, '').toLowerCase();
      if (!docNames.has(name)) {
        docNames.set(name, s);
      }
    }
  }

  let documented = 0;
  {
    const documented_list = [],
      undocumented_list = [],
      total = (() => {
        for (const sym of symbols) {
          const lowerName = sym.name.toLowerCase(),
            matched = docNames.has(lowerName) || docNames.has(lowerName.replace(/_/g, ''));
          if (matched) {
            documented++;
            documented_list.push(sym);
          } else {
            undocumented_list.push(sym);
          }
        }

        return symbols.length;
      })();
    return {
      total_symbols: total,
      documented,
      undocumented: undocumented_list.length,
      coverage_pct: total > 0 ? Math.round((documented / total) * 100) : 0,
      documented_list: documented_list.slice(0, RESULT_LIMITS.DOC_COVERAGE_LIST_LIMIT),
      undocumented_list: undocumented_list.slice(0, RESULT_LIMITS.DOC_COVERAGE_LIST_LIMIT),
    };
  }
}

function getDocCoverage(db, repoId, docRepoId, opts = {}) {
  const codeSymbolLookup = opts.codeSymbolLookup || createDbCodeSymbolLookup(db),
    symbols = codeSymbolLookup.listDocumentableSymbols(repoId),
    sections = db.prepare('SELECT id, title, content, role FROM doc_sections WHERE repo_id = ?').all(docRepoId);
  return getDocCoverageReport(symbols, sections);
}

function getDuplicateSections(db, repoId) {
  const duplicates = db
      .prepare(`
    SELECT
      content_hash,
      COUNT(*) as count,
      GROUP_CONCAT(id) as section_ids,
      GROUP_CONCAT(title, '|||') as titles,
      GROUP_CONCAT(file_id) as file_ids
    FROM doc_sections
    WHERE repo_id = ? AND content_hash != '' AND content IS NOT NULL
    GROUP BY content_hash
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `)
      .all(repoId),
    results = [];
  for (const dup of duplicates) {
    const ids = dup.section_ids.split(',').map(Number),
      titles = dup.titles.split('|||'),
      fileIds = dup.file_ids.split(',').map(Number),
      sections = [];
    for (let i = 0; i < ids.length; i++) {
      const fileId = fileIds[i] || fileIds[0],
        fileRow = db.prepare('SELECT path FROM doc_files WHERE id = ?').get(fileId);
      sections.push({ id: ids[i], title: titles[i] || '', file_path: fileRow ? fileRow.path : '' });
    }

    results.push({ content_hash: dup.content_hash, count: dup.count, sections });
  }

  return { duplicates: results, total_duplicate_groups: results.length };
}

function getStalePages(db, repoId) {
  const repo = db.prepare('SELECT path FROM doc_repos WHERE id = ?').get(repoId);
  if (!repo) {
    return { error: 'Repo not found' };
  }

  const files = db.prepare('SELECT id, path, mtime, content_hash FROM doc_files WHERE repo_id = ?').all(repoId),
    stale = [],
    missing = [];

  for (const file of files) {
    const fullPath = path.join(repo.path, file.path);
    try {
      const stat = fs.statSync(fullPath);
      if (file.mtime && stat.mtimeMs > file.mtime) {
        stale.push({
          id: file.id,
          path: file.path,
          indexed_mtime: file.mtime,
          current_mtime: stat.mtimeMs,
          reason: 'modified',
        });
      }
    } catch {
      missing.push({ id: file.id, path: file.path, reason: 'missing' });
    }
  }

  return { stale, missing, total_files: files.length };
}

module.exports = {
  searchDocs,
  getTutorialPath,
  getOrphanSections,
  createDbCodeSymbolLookup,
  getDocCoverageReport,
  getDocCoverage,
  getDuplicateSections,
  getStalePages,
};
