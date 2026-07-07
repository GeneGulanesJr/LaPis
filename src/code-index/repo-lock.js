const waiters = new Map();
const holding = new Set();

/**
 * Serialize full/incremental index operations per repo name.
 * Reentrant for nested calls (e.g. reindex full mode -> indexRepository).
 */
async function withRepoIndexLock(repoName, fn) {
  const key = String(repoName || '').toLowerCase();
  if (holding.has(key)) {
    return fn();
  }
  while (waiters.has(key)) {
    // oxlint-disable-next-line no-await-in-loop
    await waiters.get(key);
  }
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  waiters.set(key, gate);
  holding.add(key);
  try {
    return await fn();
  } finally {
    holding.delete(key);
    waiters.delete(key);
    release();
  }
}

module.exports = { withRepoIndexLock };
