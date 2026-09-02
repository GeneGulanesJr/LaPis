function parseExpiresIn(duration) {
  if (duration == null) {
    return null;
  }
  const raw = String(duration).trim().toLowerCase(),
  match = raw ? (raw.match(/^(\d+)\s*([hdwm])$/)) : undefined,
  n = raw && match ? (parseInt(match[1], 10)) : undefined,
  unit = raw && match ? (match[2]) : undefined;
  if (!raw) {
    return null;
  }
  if (!match) {
    return null;
  }
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
    // Fixed 30-day month. Calendar-month arithmetic (setUTCMonth) varies 28-31
    // Days by month, making expiry non-deterministic (e.g. 1m set on Jul 1
    // Expired in 31 days). A TTL unit should be deterministic, matching the
    // Documented "1m = 30 days" contract (see test/memory-ttl.test.js).
    now.setUTCDate(now.getUTCDate() + n * 30);
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
