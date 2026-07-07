// Module boundary:
// MCP transport adapter for LaPis. Exposes the transport-agnostic
// Gateway.dispatch() core over the Model Context Protocol (stdio).
// Mirrors how the Pi extension's memory-client.ts consumes dispatch —
// No business logic here, only framing and tool routing.
//
// This is the SECOND transport alongside the Pi extension. The Pi extension
// Remains primary (it owns hooks, TUI rendering, session lifecycle). MCP
// Gets the tool surface only, which is the natural protocol boundary.

const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { tools } = require('./tools');
const { toCallToolResult } = require('./translate-result');
const { resolveCwd, projectFromCwd, resolveProjectKey } = require('../hooks-engine/project');
const { getKnownRepos, getKnownProjects } = require('../platform/project-db');

const SERVER_NAME = 'lapis';
const SERVER_VERSION = require('../../package.json').version || '0.0.0';

/**
 * Derive the MCP project key from cwd, preferring an indexed repo whose path
 * contains cwd (monorepo subdirs) before falling back to the basename heuristic.
 * Uses the same hooks-engine helpers as the Claude Code bridge.
 */
function detectMcpProject(cwd) {
  const resolved = path.resolve(resolveCwd(cwd));
  try {
    return resolveProjectKey(resolved, getKnownRepos(), getKnownProjects());
  } catch {
    return projectFromCwd(resolved);
  }
}

/**
 * Build an MCP Server wired to the LaPis tool catalog.
 * Accepts an injected `dispatch` (defaults to the real gateway) so tests
 * can pass the SDK's InMemoryTransport without touching the real DB.
 *
 * @param {{ dispatch?: Function, project?: string }} [opts]
 * @returns {Server}
 */
function createServer(opts = {}) {
  const dispatch = opts.dispatch || require('../cli/gateway').dispatch;
  const project = opts.project || detectMcpProject();
  const ctx = { project };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'LaPis persistent memory. Use memory-save for decisions/bugfixes/discoveries, ' +
        'memory-search to recall them, memory-code/memory-doc to query indexed code & docs. ' +
        'Memories are scoped to the current project (cwd-derived).',
    },
  );

  // --- tools/list ---
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // --- tools/call ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: params } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const { cmd, args, error } = tool.toCommand(params || {}, ctx);
    if (error || !cmd) {
      return {
        content: [{ type: 'text', text: error || 'No command produced.' }],
        isError: true,
      };
    }

    let result;
    try {
      result = await dispatch(cmd, args);
    } catch (err) {
      return {
        content: [
          { type: 'text', text: `Dispatch error for ${cmd}: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }

    return toCallToolResult(result);
  });

  return server;
}

/**
 * Start the MCP server on stdio. Entry point for `lapis mcp`.
 * Owns ensureDb() — same pattern as src/http/server.js:192.
 *
 * @param {{ project?: string }} [opts]
 */
async function startMcpServer(opts = {}) {
  const db = require('../../db');
  try {
    db.ensureDb();
  } catch (err) {
    // Stdio is the only output channel MCP clients reliably read; without this
    // Guard a crash here would leave the host staring at a silent close. Emit a
    // Clear stderr line + non-zero exit so the host surfaces the failure.
    process.stderr.write(
      `lapis mcp: database initialization failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const server = createServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { createServer, startMcpServer, projectFromCwd, detectMcpProject };
