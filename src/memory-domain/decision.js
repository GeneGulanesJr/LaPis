// Decision-service client for atomic memory classification.
//
// Wires LaPis's memory-save path through a decision service (an external
// HTTP service) so every persisted memory can be gated by a classifier.
// The client is provider-agnostic: any backend implementing the
// `{ tool, state }` JSON contract works.  The reference deployment is the
// LayaMCP sidecar (github.com/GeneGulanesJr/LayaMCP) — laya is one decision
// model behind that service, not the interface — so the upstream tool names
// default to its `laya_*` tools but stay configurable via env.
//
// Classifications:
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
//   LAPIS_DECISION_URL         (http://127.0.0.1:8765)
//   LAPIS_DECISION_ENABLED     (true)
//   LAPIS_DECISION_TIMEOUT_MS  (5000)
//   LAPIS_DECISION_TOOL_PREFIX ('laya_' — wire names, e.g. laya_guard)

const DEFAULT_URL = 'http://127.0.0.1:8765',
  DEFAULT_TIMEOUT_MS = 5000,
  DEFAULT_TOOL_PREFIX = 'laya_',
  // classification → argument key the upstream tool reads the content from
  CLASSIFICATION_ARG = {
    guard: 'prompt',
    moderate: 'text',
    triage: 'text',
    email: 'body',
  },
  CLASSIFICATIONS = Object.keys(CLASSIFICATION_ARG);

class DecisionError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DecisionError';
    this.status = opts.status;
    this.body = opts.body;
    this.code = opts.code;
    this.classification = opts.classification;
  }
}

function getConfig() {
  const enabledRaw = process.env.LAPIS_DECISION_ENABLED,
    enabled = enabledRaw === undefined || enabledRaw === '' ? true : !/^(0|false|no|off)$/i.test(enabledRaw),
    url = process.env.LAPIS_DECISION_URL || DEFAULT_URL,
    timeoutRaw = process.env.LAPIS_DECISION_TIMEOUT_MS,
    timeoutMs = (() => {
      if (timeoutRaw === undefined || timeoutRaw === '') {
        return DEFAULT_TIMEOUT_MS;
      }
      const n = Number.parseInt(timeoutRaw, 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
    })();
  return { enabled, url, timeoutMs };
}

// Upstream wire name for a classification — `${prefix}${classification}`.
// The prefix defaults to the reference service's `laya_` naming so the
// existing deployment keeps working; point LAPIS_DECISION_TOOL_PREFIX at
// another backend's naming without touching this module.
function toolPrefix() {
  const raw = process.env.LAPIS_DECISION_TOOL_PREFIX;
  return raw === undefined || raw === '' ? DEFAULT_TOOL_PREFIX : raw;
}

function toolFor(classification) {
  return `${toolPrefix()}${classification}`;
}

// Generic JSON-RPC-ish POST.  The service accepts { tool, state } where
// `state` is an opaque blob the tool's input field maps onto.
// Returns the parsed JSON body.  Throws DecisionError on any failure
// mode so the caller can route on it.
async function callDecision(tool, state, opts = {}) {
  const { url, timeoutMs, enabled } = getConfig();
  if (!enabled) {
    throw new DecisionError('Decision service is disabled (LAPIS_DECISION_ENABLED=false)', { code: 'disabled' });
  }
  if (!state || typeof state !== 'object') {
    throw new DecisionError(`Decision tool ${tool} requires a state object`, { code: 'bad_input' });
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
    throw new DecisionError(
      isAbort
        ? `Decision service request to ${tool} timed out after ${opts.timeoutMs || timeoutMs}ms`
        : `Decision service request to ${tool} failed: ${err.message}`,
      { code: isAbort ? 'timeout' : 'network_error' },
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new DecisionError(`Decision service returned non-JSON from ${tool} (HTTP ${res.status}): ${err.message}`, {
      status: res.status,
      body: text.slice(0, 500),
      code: 'bad_response',
    });
  }

  if (!res.ok) {
    throw new DecisionError(
      `Decision service tool ${tool} returned HTTP ${res.status}: ${body.error || res.statusText}`,
      {
        status: res.status,
        body,
        code: 'http_error',
      },
    );
  }

  if (body && body.error) {
    // JSON-RPC / API-style error envelope from the upstream server.
    throw new DecisionError(`Decision service tool ${tool} errored: ${body.error.message || body.error}`, {
      status: res.status,
      body,
      code: 'rpc_error',
    });
  }

  return { ...body, classified_at: body.classified_at || new Date(startedAt).toISOString() };
}

// Run a specific classifier.  Returns { tool, classification, confidence,
// classified_at, result } or throws DecisionError.  `result` is the parsed
// upstream payload, `confidence` is whatever the upstream reported
// (defaults to 1.0 when absent).
async function classify(content, classification, _ctx) {
  const arg = CLASSIFICATION_ARG[classification];
  if (!arg) {
    throw new DecisionError(`Unknown classification: ${classification}`, { code: 'bad_input', classification });
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new DecisionError(`classify(${classification}) requires non-empty content`, {
      code: 'bad_input',
      classification,
    });
  }

  const tool = toolFor(classification),
    result = await callDecision(tool, { [arg]: content });
  return {
    tool,
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
  callDecision,
  classify,
  autoClassify,
  DecisionError,
  toolFor,
  toolPrefix,
  CLASSIFICATION_ARG,
  CLASSIFICATIONS,
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOL_PREFIX,
};
