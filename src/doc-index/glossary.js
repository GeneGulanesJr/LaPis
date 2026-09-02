function extractGlossaryTerms(content) {
  const terms = [],
    re = /\*\*([^*]+)\*\*\s*[—:–-]\s*(.+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const term = match[1].trim(),
      def = match[2].trim().replace(/\s+/g, ' ');
    if (term.length > 1 && term.length < 60 && def.length > 5) {
      terms.push({ term: term.toLowerCase(), definition: def });
    }
  }
  return terms;
}

function lookupTerm(db, repoId, term) {
  if (term) {
    return (
      db.prepare('SELECT * FROM doc_terms WHERE repo_id = ? AND term = ?').get(repoId, term.toLowerCase()) || {
        error: `Term "${term}" not found`,
      }
    );
  }
  return db.prepare('SELECT * FROM doc_terms WHERE repo_id = ? ORDER BY term').all(repoId);
}

module.exports = { extractGlossaryTerms, lookupTerm };
