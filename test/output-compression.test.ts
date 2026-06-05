// vitest globals (describe, test, expect, vi, beforeEach) are auto-injected
import { registerOutputCompression } from '../extensions/memory-layer/hooks/output-compression.ts';

// ---- Mock token-saver modules ----
// vi.mock is hoisted to the top of the file, before any imports

vi.mock('../src/token-saver/compress-output', () => ({
  compressOutput: vi.fn(({ stdout }: { stdout: string }) => ({
    summary: 'Mock compressed summary',
    importantOutput: 'MOCK_OUTPUT:' + stdout.slice(0, 80),
  })),
}));

vi.mock('../src/token-saver/estimate-tokens', () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(String(text || '').length / 4)),
}));

vi.mock('../src/token-saver/savings-store', () => ({
  recordRun: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  isBashToolResult: vi.fn((event: any) => event.toolName === 'bash'),
}));

// ---- Helper factories ----

function makePi() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
    getHandler: (event: string) => handlers[event],
  };
}

function makeState() {
  return {
    compressionStats: {
      totalRuns: 0,
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      totalSavedTokens: 0,
    },
  };
}

function makeConfig(overrides?: {
  enabled?: boolean;
  min_chars?: number;
  min_savings_percent?: number;
}) {
  return () => ({ output_compression: { enabled: true, min_chars: 2000, min_savings_percent: 30, ...overrides } });
}

function bashEvent(command: string, output: string, isError = false) {
  return {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call-1',
    input: { command },
    content: [{ type: 'text', text: output } as any],
    details: undefined,
    isError,
  };
}

function readEvent() {
  return {
    type: 'tool_result',
    toolName: 'read',
    toolCallId: 'call-2',
    input: { path: '/foo.ts' },
    content: [{ type: 'text', text: 'file content' } as any],
    details: undefined,
    isError: false,
  };
}

// ---- Tests ----

describe('registerOutputCompression', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('registers a tool_result handler', () => {
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig() });
    expect(pi.on).toHaveBeenCalledWith('tool_result', expect.any(Function));
  });

  test('ignores non-bash tool results', async () => {
    const pi = makePi();
    const state = makeState();
    registerOutputCompression(pi as any, { state, getConfig: makeConfig() });
    const result = await pi.getHandler('tool_result')(readEvent(), {});
    expect(result).toBeUndefined();
  });

  test('ignores short output (below min_chars threshold)', async () => {
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig() });
    const result = await pi.getHandler('tool_result')(bashEvent('echo hi', 'short'), {});
    expect(result).toBeUndefined();
  });

  test('compresses large bash output and returns modified content', async () => {
    const pi = makePi();
    const state = makeState();
    registerOutputCompression(pi as any, { state, getConfig: makeConfig() });
    const large = 'x'.repeat(5000);
    const result = await pi.getHandler('tool_result')(bashEvent('npm test', large), {});

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    // Prefix is always present
    expect(result.content[0].text).toContain('[Output compressed:');
    expect(result.content[0].text).toContain('% token savings');
    // Mock importantOutput follows MOCK_OUTPUT pattern
    expect(result.content[0].text).toContain('MOCK_OUTPUT:');
  });

  test('does not compress when config.enabled is false', async () => {
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig({ enabled: false }) });
    const large = 'x'.repeat(5000);
    const result = await pi.getHandler('tool_result')(bashEvent('npm test', large), {});
    expect(result).toBeUndefined();
  });

  test('updates compressionStats after compression', async () => {
    const pi = makePi();
    const state = makeState();
    registerOutputCompression(pi as any, { state, getConfig: makeConfig() });
    const large = 'x'.repeat(5000);
    await pi.getHandler('tool_result')(bashEvent('npm test', large), {});

    expect(state.compressionStats.totalRuns).toBe(1);
    expect(state.compressionStats.totalOriginalTokens).toBeGreaterThan(0);
    expect(state.compressionStats.totalSavedTokens).toBeGreaterThan(0);
  });

  test('calls recordRun with correct data', async () => {
    const { recordRun } = await import('../src/token-saver/savings-store');
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig() });
    const large = 'x'.repeat(5000);
    await pi.getHandler('tool_result')(bashEvent('npm test', large), {});

    expect(recordRun).toHaveBeenCalledTimes(1);
    const call = (recordRun as any).mock.calls[0][0];
    expect(call.command).toBe('npm test');
    expect(call.savingsPercent).toBeGreaterThan(0);
  });

  test('handles missing text content (image-only) gracefully', async () => {
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig() });
    const event = { ...bashEvent('npm test', ''), content: [{ type: 'image', data: '...' } as any] };
    const result = await pi.getHandler('tool_result')(event, {});
    expect(result).toBeUndefined();
  });

  test('recordRun failure does not break tool result', async () => {
    const { recordRun } = await import('../src/token-saver/savings-store');
    recordRun.mockImplementation(() => { throw new Error('DB locked'); });
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig() });
    const large = 'x'.repeat(5000);
    // Must NOT throw
    const result = await pi.getHandler('tool_result')(bashEvent('npm test', large), {});
    expect(result).toBeDefined();
    expect(result.content[0].text).toContain('MOCK_OUTPUT:');
  });

  test('uses defaults when output_compression config key is absent', async () => {
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: () => ({}) });
    const large = 'x'.repeat(5000);
    const result = await pi.getHandler('tool_result')(bashEvent('git diff', large), {});
    expect(result).toBeDefined();
  });

  test('sets exitCode to 1 when isError is true', async () => {
    const { compressOutput } = await import('../src/token-saver/compress-output');
    const pi = makePi();
    registerOutputCompression(pi as any, { state: makeState() as any, getConfig: makeConfig() });
    const large = 'FAIL '.repeat(2000);
    await pi.getHandler('tool_result')(bashEvent('npm test', large, true), {});
    expect(compressOutput).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: 1 }),
    );
  });
});
