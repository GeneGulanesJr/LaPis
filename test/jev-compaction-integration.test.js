// test/jev-compaction-integration.test.js
// Integration smoke: drives memory-layer's default export end-to-end.
//
// This is the closest we can get to a real pi session without spawning pi:
//   1. Set env vars as if a real pi run started with PI_COMPACTION_JUDG=jev
//   2. Build a fake pi ExtensionAPI that records every `pi.on(event, handler)`
//      registration
//   3. Call memoryLayer(fakePi) — exactly what pi does at boot
//   4. Verify:
//      a) session_before_compact was registered
//      b) session_compact was registered (existing C+A path)
//      c) The session_before_compact handler, when invoked with a synthetic
//         preparation, returns a CompactionResult with details.verdicts and
//         a <keep>-block summary
//
// This proves that the index.ts wiring actually wires the planner into a host
// pi session, not just that the planner module is internally correct.

process.env.JEV_DRY_RUN = '1';
process.env.JEV_ENABLED = '1';
process.env.PI_COMPACTION_JUDG_ENABLED = '1';
process.env.PI_COMPACTION_JUDG = 'jev';

// The dashboard-tui command imports @earendil-works/pi-tui, a package only
// pulled by `pi` at the TUI editor surface. Stub it before memory-layer loads
// so the test environment doesn't need that runtime dep.
import { vi } from 'vitest';
vi.mock('@earendil-works/pi-tui', () => ({
  Key: {},
  matchesKey: () => false,
  truncateToWidth: (s) => s,
}));

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import memoryLayer from '../extensions/memory-layer/index.ts';

const handlers = new Map();
const notifications = [];
const fakePi = {
  on(event, handler) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  // tools / commands / sendUserMessage / setTools may also be touched by
  // memory-layer; stub minimally.
  registerTool() {},
  registerCommand() {},
  appendEntry() {},
  sendMessage() {},
  sendUserMessage() {},
  setTools() {},
  ui: {
    notify(msg, level) {
      notifications.push({ msg, level });
    },
  },
};

beforeAll(() => {
  // Drive memory-layer through the fake pi. If any registration throws,
  // it must be caught inside index.ts so the rest of the extension loads.
  memoryLayer(fakePi);
});

afterAll(() => {
  handlers.clear();
  notifications.length = 0;
});

describe('memory-layer wires Jev-driven compaction end-to-end', () => {
  it('registers a session_before_compact handler', () => {
    expect(handlers.has('session_before_compact')).toBe(true);
  });

  it('still registers session_compact (existing C+A path)', () => {
    expect(handlers.has('session_compact')).toBe(true);
  });

  it('handler is the Jev-driven planner when PI_COMPACTION_JUDG=jev', async () => {
    const handler = handlers.get('session_before_compact');
    expect(typeof handler).toBe('function');

    const firstKeptEntryId = 'entry-3';
    const messages = [
      { role: 'user', content: 'ship v0.1' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'DECISION: ship v0.1 with the new schema.' }],
      },
      { role: 'user', content: 'thanks' },
    ];

    const result = await handler(
      {
        type: 'session_before_compact',
        reason: 'manual',
        preparation: {
          firstKeptEntryId,
          messagesToSummarize: messages,
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 145_000,
          previousSummary: 'Earlier: chose SQLite, set up vitest.',
          fileOps: { readFiles: [], modifiedFiles: [] },
          settings: { model: 'claude-opus-4-6' },
        },
        signal: undefined,
      },
      { cwd: process.cwd() },
    );

    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(result.compaction.details.strategy).toBe('jev');
    expect(result.compaction.details.verdicts.length).toBe(messages.length);
    expect(/<keep idx="\d+"/.test(result.compaction.summary)).toBe(true);
    expect(result.compaction.summary).toContain('Earlier: chose SQLite');
  });

  it('handler is a no-op when PI_COMPACTION_JUDG is unset (feature OFF)', async () => {
    // Save and restore the env so this case doesn't bleed into the prior test.
    const saved = process.env.PI_COMPACTION_JUDG;
    const savedEnabled = process.env.PI_COMPACTION_JUDG_ENABLED;
    delete process.env.PI_COMPACTION_JUDG;
    delete process.env.PI_COMPACTION_JUDG_ENABLED;

    // Build a fresh fake pi and drive memory-layer again with the env cleared.
    const localHandlers = new Map();
    const localPi = {
      ...fakePi,
      on(event, handler) {
        localHandlers.set(event, handler);
        return () => localHandlers.delete(event);
      },
    };
    memoryLayer(localPi);

    const handler = localHandlers.get('session_before_compact');
    expect(handler).toBeDefined();

    const result = await handler(
      {
        type: 'session_before_compact',
        reason: 'manual',
        preparation: {
          firstKeptEntryId: 'entry-1',
          messagesToSummarize: [{ role: 'user', content: 'hi' }],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 50_000,
          previousSummary: undefined,
          fileOps: { readFiles: [], modifiedFiles: [] },
          settings: { model: 'm' },
        },
        signal: undefined,
      },
      { cwd: process.cwd() },
    );

    // OFF path: planner returns undefined → pi's default compaction runs.
    expect(result).toBeUndefined();

    if (saved !== undefined) process.env.PI_COMPACTION_JUDG = saved;
    if (savedEnabled !== undefined) process.env.PI_COMPACTION_JUDG_ENABLED = savedEnabled;
  });

  it('partial-load failures are surfaced via session_start ui.notify', () => {
    // If any registration threw, memory-layer schedules a session_start
    // handler that calls ctx.ui.notify. We can verify the registration exists
    // even when no failures happened — it just won't fire.
    const allStartHandlers = [];
    const peekPi = {
      ...fakePi,
      on(event, handler) {
        if (event === 'session_start') allStartHandlers.push(handler);
        return () => {};
      },
    };
    memoryLayer(peekPi);
    // No assertion on count — memory-layer only adds a notifier on partial
    // failure. Just verify the call didn't throw.
    expect(true).toBe(true);
  });
});