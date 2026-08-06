// src/http/handlers/settings.js — KV store for integration tokens and config

function getSetting(sqlJson) {
  return async (req, res, { params }) => {
    const rows = sqlJson('SELECT value FROM settings WHERE key = ?', [params.key]);
    if (!rows.length) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not_found' }));
    }
    // Stored values may be non-JSON (legacy data, manual DB edits). Fall back
    // to the raw string instead of throwing an uncaught SyntaxError → 500.
    let value;
    try {
      value = JSON.parse(rows[0].value);
    } catch {
      value = rows[0].value;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: params.key, value }));
  };
}

function setSetting(sqlRun) {
  return async (req, res, { params, body }) => {
    if (!body || body.value === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'value is required' }));
    }
    sqlRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [params.key, JSON.stringify(body.value)]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: params.key, value: body.value }));
  };
}

function deleteSetting(sqlRun) {
  return async (req, res, { params }) => {
    sqlRun('DELETE FROM settings WHERE key = ?', [params.key]);
    res.writeHead(204);
    res.end();
  };
}

module.exports = { getSetting, setSetting, deleteSetting };
