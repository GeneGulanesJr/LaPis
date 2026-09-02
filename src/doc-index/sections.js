function buildSectionHierarchy(sections) {
  const stack = [],
    result = [];
  for (let idx = 0; idx < sections.length; idx++) {
    const sec = sections[idx];
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) {
      stack.pop();
    }
    result.push({ ...sec, parent_idx: stack.length > 0 ? stack[stack.length - 1].idx : null });
    stack.push({ level: sec.level, idx });
  }
  return result;
}

function buildOutlineTree(sections) {
  const byId = new Map();
  for (const s of sections) {
    byId.set(s.id, { ...s, children: [] });
  }
  const roots = [];
  for (const s of sections) {
    const node = byId.get(s.id);
    if (s.parent_id && byId.has(s.parent_id)) {
      byId.get(s.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function getDocOutline(db, repoId, filePath) {
  if (filePath) {
    const file = db.prepare('SELECT id FROM doc_files WHERE repo_id = ? AND path LIKE ?').get(repoId, `%${filePath}%`);
    if (!file) {
      return { error: `Doc file not found: ${filePath}` };
    }
    const sections = db
      .prepare('SELECT id, title, level, parent_id, role FROM doc_sections WHERE file_id = ? ORDER BY byte_start')
      .all(file.id);
    return buildOutlineTree(sections);
  }
  const files = db
    .prepare(`
    SELECT df.path, COUNT(ds.id) as section_count FROM doc_files df LEFT JOIN doc_sections ds ON ds.file_id = df.id
    WHERE df.repo_id = ? GROUP BY df.id ORDER BY df.path
  `)
    .all(repoId);
  return { files };
}

module.exports = { buildSectionHierarchy, buildOutlineTree, getDocOutline };
