// test/compaction-judg-reregistration.test.js
// Regression for issue #363: pi caches extension modules but re-invokes the
// memoryLayer() factory per runtime (resume/fork). The second invocation used
// to throw 'CompactionJudg "default" already registered with a different impl'
// because the factory registered fresh strategy instances against the
// module-scoped REGISTRY, and it leaked registrationFailures across
// invocations, producing a spurious "partially loaded" warning.
//
// This file boots the factory several times on the SAME module instance —
// what pi actually does on resume/fork — and asserts every boot is clean.

import { vi } from 'vitest';

// The dashboard-tui command imports @earendil-works/pi-tui, a package only
// pulled by `pi` at the TUI editor surface. Stub it before memory-layer loads
// so the test environment doesn't need that runtime dep.
vi.mock('@earendil-works/pi-tui', () => ({
  Key: {},
  matchesKey: () => false,
  truncateToWidth: (s) => s,
}));

import { describe, it, expect } from 'vitest';
import memoryLayer from '../extensions/memory-layer/index.ts';
import { listRegisteredJudg, registerCompactionJudg } from '../extensions/memory-layer/host/compaction-judg';

function makeFakePi() {
  const handlers = new Map();
  const pi = {
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
      notify() {},
    },
  };
  return { pi, handlers };
}

/** Boot the factory once and assert the boot itself is silent and complete. */
function bootAndAssert() {
  const { pi, handlers } = makeFakePi();
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    memoryLayer(pi);
    expect(errSpy).not.toHaveBeenCalled();
    expect(handlers.has('session_before_compact')).toBe(true);
    expect(handlers.has('session_compact')).toBe(true);
    expect(listRegisteredJudg()).toEqual(expect.arrayContaining(['default', 'noop', 'jev']));
  } finally {
    errSpy.mockRestore();
  }
}

describe('memoryLayer() re-invocation on cached modules (resume/fork)', () => {
  it('first boot registers everything cleanly', () => {
    bootAndAssert();
  });

  it('second and third boots stay clean: no errors, hooks still register', () => {
    bootAndAssert();
    bootAndAssert();
  });

  it('a genuinely different custom impl under a builtin name is still rejected', () => {
    expect(() =>
      registerCompactionJudg('default', {
        name: 'default',
        decideKeep: async () => ({ verdict: 0, confidence: 1 }),
      }),
    ).toThrow(/different impl/);
  });
});
