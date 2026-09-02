const { RESULT_LIMITS } = require('../../constants');

function extractCodeBlocks(content, sectionByteStart) {
  const blocks = [],
    lines = content.split('\n');
  let inBlock = false,
    lang = '',
    blockContent = [],
    blockStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && line.match(/^```/)) {
      inBlock = true;
      lang = line.replace(/^```\s*/, '').trim();
      blockContent = [];
      blockStartLine = i;
    } else if (inBlock && line.match(/^```\s*$/)) {
      inBlock = false;
      const blockText = blockContent.join('\n'),
        preBytes = lines.slice(0, blockStartLine).reduce((s, l) => s + l.length + 1, 0),
        closingFenceBytes = lines.slice(0, i).reduce((s, l) => s + l.length + 1, 0) + line.length;
      blocks.push({
        lang: lang || '',
        content: blockText,
        byte_start: sectionByteStart + preBytes,
        byte_end: sectionByteStart + closingFenceBytes,
      });
    } else if (inBlock) {
      blockContent.push(line);
    }
  }
  return blocks;
}

function findCodeExamples(db, repoId, query, lang) {
  let sql = `SELECT dcb.id, dcb.lang, dcb.content, ds.title as section_title, df.path as file_path
    FROM doc_code_blocks dcb JOIN doc_sections ds ON ds.id = dcb.section_id JOIN doc_files df ON df.id = ds.file_id
    WHERE ds.repo_id = ? AND dcb.content LIKE ?`;
  const params = [repoId, `%${query}%`];
  if (lang) {
    sql += ' AND dcb.lang = ?';
    params.push(lang);
  }
  sql += ` LIMIT ${RESULT_LIMITS.DOC_CODE_EXAMPLES_LIMIT}`;
  return { results: db.prepare(sql).all(...params) };
}

module.exports = { extractCodeBlocks, findCodeExamples };
