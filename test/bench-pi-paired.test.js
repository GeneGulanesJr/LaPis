import { describe, expect, it } from 'vitest';

const { buildSummary, parsePiOutput } = require('../bench/bench-pi-paired.js');

describe('bench pi paired parser', () => {
  it('counts usage once when Pi repeats it for the same response', () => {
    const raw = [
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            responseId: 'resp_1',
            usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.12 } },
            content: [{ type: 'text', text: 'First final answer.' }],
          },
        }),
        JSON.stringify({
          type: 'turn_end',
          message: {
            role: 'assistant',
            responseId: 'resp_1',
            usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.12 } },
            content: [{ type: 'text', text: 'First final answer.' }],
          },
        }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            responseId: 'resp_2',
            usage: { input_tokens: 50, output_tokens: 10, cache_read_tokens: 5 },
            content: 'Second final answer.',
          },
        }),
      ].join('\n'),
      parsed = parsePiOutput(raw);

    expect(parsed.usage.input_tokens).toBe(150);
    expect(parsed.usage.output_tokens).toBe(30);
    expect(parsed.usage.cache_read_tokens).toBe(35);
    expect(parsed.usage.cache_write_tokens).toBe(40);
    expect(parsed.usage.active_tokens).toBe(180);
    expect(parsed.usage.effective_tokens).toBe(215);
    expect(parsed.usage.cache_discounted_tokens).toBe(184);
    expect(parsed.usage.total_tokens).toBe(215);
    expect(parsed.usage.answer_active_tokens).toBe(180);
    expect(parsed.usage.setup_active_tokens).toBe(0);
    expect(parsed.usage.cost_usd).toBe(0.12);
    expect(parsed.answer).toBe('First final answer.\nSecond final answer.');
    expect(parsed.behavior.assistant_turns).toBe(2);
  });

  it('separates final answer tokens from setup/tool-call overhead', () => {
    const raw = [
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            responseId: 'resp_setup',
            usage: { input: 1000, output: 25 },
            content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'skill.md' } }],
          },
        }),
        JSON.stringify({ type: 'tool_execution_start', toolName: 'read' }),
        JSON.stringify({ type: 'tool_execution_end', toolName: 'read', result: { content: [] } }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            responseId: 'resp_answer',
            usage: { input: 10, output: 40, cacheRead: 200 },
            content: [{ type: 'text', text: 'Final answer.' }],
          },
        }),
      ].join('\n'),
      parsed = parsePiOutput(raw);

    expect(parsed.usage.active_tokens).toBe(1075);
    expect(parsed.usage.effective_tokens).toBe(1275);
    expect(parsed.usage.cache_discounted_tokens).toBe(1095);
    expect(parsed.usage.answer_active_tokens).toBe(50);
    expect(parsed.usage.setup_active_tokens).toBe(1025);
    expect(parsed.behavior.tool_names).toEqual(['read']);
    expect(parsed.answer).toBe('Final answer.');
  });

  it('classifies usage as answer tokens when text arrives in streamed updates before usage', () => {
    const raw = [
        JSON.stringify({
          type: 'message_start',
          message: {
            role: 'assistant',
            responseId: 'resp_answer',
          },
        }),
        JSON.stringify({
          type: 'message_update',
          message: {
            role: 'assistant',
            responseId: 'resp_answer',
            content: [{ type: 'text', text: 'Streamed final answer.' }],
          },
        }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            responseId: 'resp_answer',
            usage: { input: 100, output: 25 },
            content: [],
          },
        }),
      ].join('\n'),
      parsed = parsePiOutput(raw);

    expect(parsed.usage.answer_active_tokens).toBe(125);
    expect(parsed.usage.setup_active_tokens).toBe(0);
    expect(parsed.answer).toBe('Streamed final answer.');
    expect(parsed.behavior.missing_answer_usage_responses).toBe(0);
  });

  it('flags streamed final answers that do not have matching usage events', () => {
    const raw = JSON.stringify({
        type: 'message_update',
        message: {
          role: 'assistant',
          responseId: 'resp_answer',
          content: [{ type: 'text', text: 'Final answer without usage.' }],
        },
      }),
      parsed = parsePiOutput(raw);

    expect(parsed.usage.answer_active_tokens).toBe(0);
    expect(parsed.behavior.missing_answer_usage_responses).toBe(1);
    expect(parsed.answer).toBe('Final answer without usage.');
  });

  it('does not grade structured Pi error transcripts as answers', () => {
    const raw = [
        JSON.stringify({
          type: 'message_start',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Question mentioning rankObservations and typeBoost.' }],
          },
        }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Connection error.',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }),
        JSON.stringify({
          type: 'auto_retry_end',
          success: false,
          finalError: 'Connection error.',
        }),
      ].join('\n'),
      parsed = parsePiOutput(raw);

    expect(parsed.answer).toBe('');
    expect(parsed.behavior.error_events).toBe(2);
    expect(parsed.parse_warning).toBe('Pi events contained errors and no assistant answer');
  });

  it('counts executed tools from Pi tool execution events', () => {
    const raw = [
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            responseId: 'resp_tool',
            usage: { input: 10, output: 5 },
            content: [{ type: 'toolCall', id: 'call_1', name: 'memory-code', arguments: { mode: 'search' } }],
          },
        }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'call_1',
          toolName: 'memory-code',
          args: { mode: 'search' },
        }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'call_1',
          toolName: 'memory-code',
          result: { content: [] },
        }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'call_2',
          toolName: 'read',
          args: { path: 'src/memory-domain/search.js', offset: 45, limit: 40 },
        }),
      ].join('\n'),
      parsed = parsePiOutput(raw);

    expect(parsed.tool_counts).toEqual({
      'memory-code': 1,
      read: 1,
    });
    expect(parsed.behavior).toMatchObject({
      assistant_turns: 1,
      tool_calls: 2,
      failed_tool_calls: 0,
      memory_tool_calls: 1,
      code_tool_calls: 2,
    });
  });

  it('summarizes behavior counters', () => {
    const summary = buildSummary([
      {
        memory_off: {
          elapsed_ms: 10,
          usage: {
            active_tokens: 100,
            cache_read_tokens: 20,
            effective_tokens: 120,
            cache_discounted_tokens: 102,
            answer_active_tokens: 80,
            setup_active_tokens: 20,
            cost_usd: 0.1,
          },
          grade: { matched: 1, total: 1 },
          behavior: {
            tool_calls: 2,
            failed_tool_calls: 1,
            memory_tool_calls: 0,
            code_tool_calls: 1,
            assistant_turns: 2,
          },
        },
        memory_on: {
          elapsed_ms: 5,
          usage: {
            active_tokens: 50,
            cache_read_tokens: 30,
            effective_tokens: 80,
            cache_discounted_tokens: 53,
            answer_active_tokens: 40,
            setup_active_tokens: 10,
            cost_usd: 0.06,
          },
          grade: { matched: 1, total: 1 },
          behavior: {
            tool_calls: 1,
            failed_tool_calls: 0,
            memory_tool_calls: 1,
            code_tool_calls: 1,
            assistant_turns: 1,
          },
        },
      },
    ]);

    expect(summary.memory_off_tool_calls).toBe(2);
    expect(summary.memory_on_tool_calls).toBe(1);
    expect(summary.memory_off_failed_tool_calls).toBe(1);
    expect(summary.memory_on_failed_tool_calls).toBe(0);
    expect(summary.memory_on_memory_tool_calls).toBe(1);
    expect(summary.memory_on_code_tool_calls).toBe(1);
    expect(summary.memory_on_assistant_turns).toBe(1);
    expect(summary.memory_on_elapsed_ms).toBe(5);
    expect(summary.memory_off_effective_tokens).toBe(120);
    expect(summary.memory_on_effective_tokens).toBe(80);
    expect(summary.memory_off_cache_discounted_tokens).toBe(102);
    expect(summary.memory_on_cache_discounted_tokens).toBe(53);
    expect(summary.memory_off_answer_active_tokens).toBe(80);
    expect(summary.memory_on_answer_active_tokens).toBe(40);
    expect(summary.memory_off_setup_active_tokens).toBe(20);
    expect(summary.memory_on_setup_active_tokens).toBe(10);
    expect(summary.memory_off_cost_usd).toBe(0.1);
    expect(summary.memory_on_cost_usd).toBe(0.06);
    expect(summary.effective_token_savings_pct).toBe('33.3%');
    expect(summary.cache_discounted_token_savings_pct).toBe('48.0%');
    expect(summary.answer_token_savings_pct).toBe('50.0%');
    expect(summary.cost_savings_pct).toBe('40.0%');
    expect(summary.categories[0]).toMatchObject({
      memory_off_effective_tokens: 120,
      memory_on_effective_tokens: 80,
      memory_off_cache_discounted_tokens: 102,
      memory_on_cache_discounted_tokens: 53,
      memory_off_answer_active_tokens: 80,
      memory_on_answer_active_tokens: 40,
      memory_off_setup_active_tokens: 20,
      memory_on_setup_active_tokens: 10,
      effective_token_savings_pct: '33.3%',
      cache_discounted_token_savings_pct: '48.0%',
      answer_token_savings_pct: '50.0%',
    });
  });
});
