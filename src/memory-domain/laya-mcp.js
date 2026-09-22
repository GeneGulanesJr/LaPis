// LayaMCP HTTP client for atomic memory classification.
//
// Wires LaPis's memory-save path through LayaMCP (an external HTTP service)
// So every persisted memory is gated by a classifier.  The classifier can:
//
//   * Guard       — detect prompt injection in user-supplied content
//   * Moderate    — detect harmful / blocked content
//   * Triage      — route bug reports / tickets / status updates
//   * Email       — route inbound email bodies
//   * Auto        — pick a classifier from the content's shape
//
// Defensive failure semantics live in src/cli/commands/memory.js
// (commands['save-classified']).  This module is transport only.
//
// Env vars (defaults in parens):
//   LAPIS_LAYAMCP_URL        (http://127.0.0.1:8765)
//   LAPIS_LAYAMCP_ENABLED    (true)
//   LAPIS_LAYAMCP_TIMEOUT_MS (5000)

const DEFAULT_URL = 'http://127.0.0.1:8765',
  DEFAULT_TIMEOUT_MS = 5000,
  // Classification → (LayaMCP tool name, argument key, content field on result)
  CLASSIFICATION_TOOL = {
    guard: { tool: 'laya_guard', arg: 'prompt', resultField: 'guard' },
    moderate: { tool: 'laya_moderate', arg: 'text', resultField: 'moderate' },
    triage: { tool: 'laya_triage', arg: 'text', resultField: 'triage' },
    email: { tool: 'laya_email', arg: 'body', resultField: 'email' },
  };

class LayaMCPError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LayaMCPError';
    this.status = opts.status;
    this.body = opts.body;
    this.code = opts.code;
    this.classification = opts.classification;
  }
}

function getConfig() {
  const enabledRaw = process.env.LAPIS_LAYAMCP_ENABLED,
    enabled = enabledRaw === undefined || enabledRaw === '' ? true : !/^(0|false|no|off)$/i.test(enabledRaw),
    url = process.env.LAPIS_LAYAMCP_URL || DEFAULT_URL,
    timeoutRaw = process.env.LAPIS_LAYAMCP_TIMEOUT_MS,
    timeoutMs = (() => {
      if (timeoutRaw === undefined || timeoutRaw === '') {
        return DEFAULT_TIMEOUT_MS;
      }
      const n = Number.parseInt(timeoutRaw, 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
    })();
  return { enabled, url, timeoutMs };
}

// Generic JSON-RPC-ish POST.  LayaMCP accepts { tool, state } where
// `state` is an opaque blob the tool's input field maps onto.
// Returns the parsed JSON body.  Throws LayaMCPError on any failure
// Mode so the caller can route on it.
async function callLayaMCP(tool, state, opts = {}) {
  const { url, timeoutMs, enabled } = getConfig();
  if (!enabled) {
    throw new LayaMCPError('LayaMCP is disabled (LAPIS_LAYAMCP_ENABLED=false)', { code: 'disabled' });
  }
  if (!state || typeof state !== 'object') {
    throw new LayaMCPError(`LayaMCP tool ${tool} requires a state object`, { code: 'bad_input' });
  }

  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), opts.timeoutMs || timeoutMs),
    startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool, state }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err.name === 'AbortError' || controller.signal.aborted;
    throw new LayaMCPError(
      isAbort
        ? `LayaMCP request to ${tool} timed out after ${opts.timeoutMs || timeoutMs}ms`
        : `LayaMCP request to ${tool} failed: ${err.message}`,
      { code: isAbort ? 'timeout' : 'network_error' },
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new LayaMCPError(`LayaMCP returned non-JSON from ${tool} (HTTP ${res.status}): ${err.message}`, {
      status: res.status,
      body: text.slice(0, 500),
      code: 'bad_response',
    });
  }

  if (!res.ok) {
    throw new LayaMCPError(`LayaMCP tool ${tool} returned HTTP ${res.status}: ${body.error || res.statusText}`, {
      status: res.status,
      body,
      code: 'http_error',
    });
  }

  if (body && body.error) {
    // JSON-RPC / API-style error envelope from the upstream server.
    throw new LayaMCPError(`LayaMCP tool ${tool} errored: ${body.error.message || body.error}`, {
      status: res.status,
      body,
      code: 'rpc_error',
    });
  }

  return { ...body, classified_at: body.classified_at || new Date(startedAt).toISOString() };
}

// Run a specific classifier.  Returns { tool, result, confidence,
// Classified_at, raw } or throws LayaMCPError.  `result` is the
// Parsed upstream payload, `confidence` is whatever the upstream
// Reported (defaults to 1.0 when absent).
async function classify(content, classification, _ctx) {
  const mapping = CLASSIFICATION_TOOL[classification];
  if (!mapping) {
    throw new LayaMCPError(`Unknown classification: ${classification}`, { code: 'bad_input', classification });
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new LayaMCPError(`classify(${classification}) requires non-empty content`, {
      code: 'bad_input',
      classification,
    });
  }

  const result = await callLayaMCP(mapping.tool, { [mapping.arg]: content });
  return {
    tool: mapping.tool,
    classification,
    confidence: typeof result.confidence === 'number' ? result.confidence : 1.0,
    result,
    classified_at: result.classified_at,
  };
}

// Heuristic classifier dispatch.  Returns one of
// {classification, reason} | null.  Order matters — the first match wins.
//
//   Email    → "From:" / "Subject:" / RFC-5322-ish header lines at the top
//   Triage   → "Ticket #N", "Status:", "Priority:", or "Severity:" keywords
//   Guard    → short single-paragraph user prompt
//   Moderate → longer multi-paragraph payload
//   Null     → unrecognised; caller decides whether to fall through
function autoClassify(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return null;
  }
  const head = content.slice(0, 512);
  if (/^\s*(?<header>From|Subject|To|Cc|Date)\s*:/im.test(head)) {
    return { classification: 'email', reason: 'header-like content' };
  }
  if (/\bTicket\s*#\d+/i.test(head) || /\b(?<kw>Status|Priority|Severity)\s*:/i.test(head)) {
    return { classification: 'triage', reason: 'ticket-like content' };
  }
  const paraCount = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
  if (paraCount === 1 && content.length < 800) {
    return { classification: 'guard', reason: 'short single-paragraph' };
  }
  if (paraCount >= 2 || content.length >= 800) {
    return { classification: 'moderate', reason: 'multi-paragraph payload' };
  }
  return null;
}

module.exports = {
  callLayaMCP,
  classify,
  autoClassify,
  LayaMCPError,
  CLASSIFICATION_TOOL,
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
};
