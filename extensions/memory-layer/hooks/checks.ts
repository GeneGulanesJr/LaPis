/**
 * Check results for Pi (src/verification): capture tsc/ESLint/Vitest/Jest/pytest
 * output from the bash/powershell tools, keep the session-start baseline, and
 * run the stop gate at agent_end (a follow-up message makes the agent continue).
 * Claude Code does the same in src/claude-code/handlers/{post-tool-use,stop}.js.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import path from 'node:path';
import { state } from '../state';
import { mem } from '../host/memory-client';
import { isCheckCommand } from '../../../src/verification/checkers.js';
import { MAX_OUTPUT } from '../../../src/verification/capture.js';
import { evaluateGate, gateBaseline } from '../../../src/verification/gate.js';
import { gateEnabled, verificationEnabled } from '../../../src/verification/index.js';

interface CheckDeps {
  state: typeof state;
  mem: typeof mem;
  getConfig: () => any;
}

const SHELL_TOOLS = new Set(['bash', 'powershell']);

/** Latest check/prover runs for the repo at `cwd` (null when off, not a repo, or on error). */
export async function fetchCheckState(deps: Pick<CheckDeps, 'mem' | 'getConfig'>, cwd: string) {
  if (!verificationEnabled(deps.getConfig())) {
    return null;
  }
  try {
    const result = (await deps.mem('proof-state', { path: cwd })) as any;
    return result && !result.error ? result : null;
  } catch {
    return null;
  }
}

function resultText(event: any): string {
  // Pi keeps only the tail of long output; the full text is in details.fullOutputPath.
  const full = event?.details?.fullOutputPath;
  if (typeof full === 'string' && full) {
    try {
      const text = fs.readFileSync(full, 'utf8');
      return text.slice(-MAX_OUTPUT);
    } catch {
      // Fall back to the visible content.
    }
  }
  return (Array.isArray(event?.content) ? event.content : [])
    .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

/** Register BEFORE output compression, so the raw output is parsed. */
export function registerCheckCapture(pi: ExtensionAPI, deps: CheckDeps) {
  pi.on('tool_result', async (event: any, ctx: any) => {
    if (!SHELL_TOOLS.has(event.toolName)) {
      return;
    }
    const command = (event.input as { command?: string })?.command || '';
    if (!isCheckCommand(command) || !verificationEnabled(deps.getConfig())) {
      return;
    }
    const output = resultText(event);
    if (!output) {
      return;
    }
    try {
      await deps.mem('capture-checks', { command, output: output.slice(-MAX_OUTPUT), path: ctx.cwd });
    } catch {
      // Capture is best-effort and never changes the tool result.
    }
  });
}

export function registerCheckGate(pi: ExtensionAPI, deps: CheckDeps) {
  pi.on('session_start', async (_event: any, ctx: any) => {
    deps.state.gateBlocks = 0;
    deps.state.checkBaseline = null;
    const checks = await fetchCheckState(deps, ctx.cwd);
    if (checks) {
      deps.state.checkBaseline = gateBaseline(checks);
    }
  });

  pi.on('agent_end', async (_event: any, ctx: any) => {
    const config = deps.getConfig(),
      max = config?.verification?.gate_max_blocks ?? 3;
    if (!gateEnabled(config) || deps.state.gateBlocks >= max || deps.state.editedFiles.size === 0) {
      return;
    }
    const checks = await fetchCheckState(deps, ctx.cwd),
      edited = [...deps.state.editedFiles].map((f) => path.resolve(ctx.cwd, f)),
      verdict = evaluateGate(checks, deps.state.checkBaseline, edited);
    if (!verdict.block) {
      return;
    }
    deps.state.gateBlocks++;
    const last = deps.state.gateBlocks >= max ? '\n(Last check-gate reminder this session.)' : '';
    pi.sendUserMessage(`${verdict.reason}${last}`, { deliverAs: 'followUp' });
  });
}
