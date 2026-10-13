// DecisionMCP client for atomic memory classification.
//
// Wires LaPis's memory-save path through DecisionMCP
// (github.com/GeneGulanesJr/DecisionMCP) — an engine-agnostic MCP decision
// service — so every persisted memory can be gated by a classifier.  Laya
// is the default engine behind the service, not the interface: the client
// speaks MCP (JSON-RPC tools/call over the service's SSE endpoint) and
// targets the service's fixed `decision_*` tools.  Mirrors the contract in
// DecisionMCP's integrations/lapis-memory-save-classified.ts.
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
//   LAPIS_DECISIONMCP_URL         (http://127.0.0.1:8765 — base URL, /sse is appended)
//   LAPIS_DECISIONMCP_ENABLED     (true)
//   LAPIS_DECISIONMCP_TIMEOUT_MS  (5000)

const DEFAULT_URL = 'http://127.0.0.1:8765',
  DEFAULT_TIMEOUT_MS = 5000,
  // classification → DecisionMCP tool name + the argument key that tool
  // reads the content from (the service's fixed tool surface)
  CLASSIFICATION_TOOL = {
    guard: { tool: 'decision_guard', arg: 'prompt' },
    moderate: { tool: 'decision_moderate', arg: 'text' },
    triage: { tool: 'decision_triage', arg: 'text' },
    email: { tool: 'decision_email', arg: 'body' },
  },
  CLASSIFICATIONS = Object.keys(CLASSIFICATION_TOOL);

class DecisionError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DecisionError';
    this.code = opts.code;
    this.classification = opts.classification;
    this.body = opts.body;
  }
}

function getConfig() {
  const enabledRaw = process.env.LAPIS_DECISIONMCP_ENABLED,
    enabled = enabledRaw === undefined || enabledRaw === '' ? true : !/^(0|false|no|off)$/i.test(enabledRaw),
    url = process.env.LAPIS_DECISIONMCP_URL || DEFAULT_URL,
    timeoutRaw = process.env.LAPIS_DECISIONMCP_TIMEOUT_MS,
    timeoutMs = (() => {
      if (timeoutRaw === undefined || timeoutRaw === '') {
        return DEFAULT_TIMEOUT_MS;
      }
      const n = Number.parseInt(timeoutRaw, 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
    })();
  return { enabled, url, timeoutMs };
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

// Run a classification through DecisionMCP.  One MCP session per call
// (connect → tools/call → close): save-classified is an explicit,
// low-frequency agent action, so connection churn is fine and the client
// stays stateless across processes.
//
// `ctx.sdk` injects a { Client, SSEClientTransport } pair for tests; the
// real MCP SDK is loaded lazily otherwise so the CLI dispatch path never
// pays for it (memory.js eager-requires this module only for the
// instanceof DecisionError check).
//
// Returns { tool, classification, confidence, classified_at, result } or
// throws DecisionError.  `result` is the parsed upstream payload
// (the service serialises its Pydantic result as JSON text content),
// `confidence` defaults to 0.5 when the engine omits it.
async function classify(content, classification, ctx = {}) {
  const mapping = CLASSIFICATION_TOOL[classification];
  if (!mapping) {
    throw new DecisionError(`Unknown classification: ${classification}`, { code: 'bad_input', classification });
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new DecisionError(`classify(${classification}) requires non-empty content`, {
      code: 'bad_input',
      classification,
    });
  }
  const { enabled, url, timeoutMs } = getConfig();
  if (!enabled) {
    throw new DecisionError('DecisionMCP is disabled (LAPIS_DECISIONMCP_ENABLED=false)', {
      code: 'disabled',
      classification,
    });
  }

  const sdk = ctx.sdk || {
    Client: require('@modelcontextprotocol/sdk/client/index.js').Client,
    SSEClientTransport: require('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport,
  };
  const startedAt = Date.now(),
    client = new sdk.Client({
      name: 'lapis-save-classified',
      version: require('../../package.json').version || '0.0.0',
    });

  // Overall deadline covering both the SSE handshake and the tool call.
  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`DecisionMCP request to ${mapping.tool} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  async function run() {
    await client.connect(new sdk.SSEClientTransport(new URL('/sse', url)));
    const res = await client.callTool({ name: mapping.tool, arguments: { [mapping.arg]: content } }, undefined, {
      timeout: Math.max(0, timeoutMs - (Date.now() - startedAt)),
    });
    if (res.isError) {
      const errText = res.content && res.content[0] ? res.content[0].text : 'unknown error';
      throw new DecisionError(`DecisionMCP tool ${mapping.tool} errored: ${errText}`, {
        code: 'tool_error',
        classification,
      });
    }
    const text = res.content && res.content[0] ? res.content[0].text : '';
    if (!text) {
      throw new DecisionError(`DecisionMCP tool ${mapping.tool} returned an empty response`, {
        code: 'bad_response',
        classification,
      });
    }
    let result;
    try {
      result = JSON.parse(text);
    } catch (err) {
      throw new DecisionError(`DecisionMCP tool ${mapping.tool} returned non-JSON content: ${err.message}`, {
        code: 'bad_response',
        classification,
        body: text.slice(0, 500),
      });
    }
    return {
      tool: mapping.tool,
      classification,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      result,
      classified_at: new Date(startedAt).toISOString(),
    };
  }

  try {
    return await Promise.race([run(), deadline]);
  } catch (err) {
    if (err instanceof DecisionError) {
      throw err;
    }
    throw new DecisionError(
      /timed?\s*out/i.test(String(err.message))
        ? err.message
        : `DecisionMCP request to ${mapping.tool} failed: ${err.message}`,
      { code: /timed?\s*out/i.test(String(err.message)) ? 'timeout' : 'network_error', classification },
    );
  } finally {
    clearTimeout(deadlineTimer);
    try {
      await client.close();
    } catch {
      // Connection may never have been established.
    }
  }
}

module.exports = {
  classify,
  autoClassify,
  DecisionError,
  CLASSIFICATION_TOOL,
  CLASSIFICATIONS,
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
};
