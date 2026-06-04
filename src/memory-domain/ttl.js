function parseExpiresIn(duration) {
  if (duration == null) {
    return null;
  }
  const raw = String(duration).trim().toLowerCase();
  if (!raw) {
    return null;
  }
  const match = raw.match(/^(\d+)\s*([hdwm])$/);
  if (!match) {
    return null;
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const now = new Date();
  if (unit === 'h') {
    now.setUTCHours(now.getUTCHours() + n);
  } else if (unit === 'd') {
    now.setUTCDate(now.getUTCDate() + n);
  } else if (unit === 'w') {
    now.setUTCDate(now.getUTCDate() + n * 7);
  } else if (unit === 'm') {
    now.setUTCMonth(now.getUTCMonth() + n);
  } else {
    return null;
  }
  return formatSqliteDatetime(now);
}

function formatSqliteDatetime(d) {
  const pad = (x) => String(x).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

module.exports = { parseExpiresIn, formatSqliteDatetime };
