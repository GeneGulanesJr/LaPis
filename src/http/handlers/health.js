const { getDb } = require('../../../db');

function healthCheck(deps) {
  return async (req, res, ctx) => {
    const { jsonOk } = require('../errors'),
      // Prefer an injected getDb (test seam), else fall back to the shared DB.
      getDbFn = (deps && deps.getDb) || getDb;
    let dbReachable = false;
    try {
      const db = getDbFn();
      db.prepare('SELECT 1').get();
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
    jsonOk(res, { status: dbReachable ? 'ok' : 'degraded', db: dbReachable });
  };
}

module.exports = { healthCheck };
