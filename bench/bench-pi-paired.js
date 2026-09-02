#!/usr/bin/env node
// Paired Pi memory benchmark.
//
// This harness runs the same task pack twice:
//   1. memory off: vanilla Pi, no LaPis extension/skills/context
//   2. memory on: Pi with LaPis available
//
// It intentionally does not simulate the no-memory baseline. Both sides are
// External commands let the benchmark capture real token usage and answers.

'use strict';

const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process'),
  DEFAULT_TASKS = path.join(__dirname, 'fixtures', 'pi-memory-tasks.json'),
  PI_CONFIG_FILES = ['models.json', 'settings.json', 'auth.json'],
  MEMORY_OFF_EMPTY_SETTINGS = new Set(['packages']),
  CACHE_READ_TOKEN_WEIGHT = 0.1;


















let progressActive = false;

function benchLog(message = '') {
  finishProgress();
  console.log(message);
}

function writeProgress(message) {
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(message);
    progressActive = true;
  } else {
    console.log(message);
  }
}

function finishProgress() {
  if (progressActive && process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    progressActive = false;
  }
}

function runCommand(command, cwd, timeoutMs, outFile) {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      settled = false;
    const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      progress = setInterval(() => {
        const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
        writeProgress(
          `[bench] still running after ${Math.round((Date.now() - started) / 1000)}s, transcript ${size} bytes`,
        );
      }, 5000),
      timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
        }
      }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearInterval(progress);
        clearTimeout(timeout);
        finishProgress();
        resolve({
          status: null,
          signal: null,
          elapsed_ms: Date.now() - started,
          stdout,
          stderr,
          error: error.message,
        });
      }
    });
    child.on('close', (status, signal) => {
      if (!settled) {
        settled = true;
      }
      clearInterval(progress);
      clearTimeout(timeout);
      finishProgress();
      resolve({
        status,
        signal,
        elapsed_ms: Date.now() - started,
        stdout,
        stderr,
        error: signal === 'SIGTERM' ? `Timed out after ${timeoutMs}ms` : null,
      });
    });
  });
}

function parsePiOutput(raw) {
  const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      active_tokens: 0,
      total_tokens: 0,
      effective_tokens: 0,
      cache_discounted_tokens: 0,
      answer_active_tokens: 0,
      setup_active_tokens: 0,
      cost_usd: 0,
    },
    assistantParts = [],
    assistantByResponse = new Map(),
    seenUsage = new Set(),
    usageClassifications = [],
    toolCounts = new Map(),
    toolNames = [],
    behavior = {
      assistant_turns: 0,
      tool_calls: 0,
      failed_tool_calls: 0,
      memory_tool_calls: 0,
      code_tool_calls: 0,
      missing_answer_usage_responses: 0,
      error_events: 0,
    };
  let parsedEvents = 0;

  

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    let event;
    if (trimmed) {
      try {
        event = JSON.parse(trimmed);
      } catch {
        event = null;
      }
    }
    if (event) {
      parsedEvents++;
      const type = event.type || '',
        message = event.message || event.delta || event,
        content = message.content || event.content;
      let assistantText = '';
      if (message.role === 'assistant' && typeof content === 'string') {
        assistantText = content;
      } else if (message.role === 'assistant' && Array.isArray(content)) {
        for (const part of content) {
          if (part && part.type === 'text' && part.text) {
            assistantText += assistantText ? `\n${part.text}` : part.text;
          }
        }
      } else if ((type.includes('text') || type.includes('message')) && typeof event.text === 'string') {
        assistantText = event.text;
      }
      {
const hasAssistantAnswerText = message.role === 'assistant' && assistantText.trim().length > 0,
        eventUsage = message.usage || event.usage;
      if (eventUsage) {
        const normalizedUsage = {
            input_tokens: eventUsage.input || eventUsage.input_tokens || 0,
            output_tokens: eventUsage.output || eventUsage.output_tokens || 0,
            cache_read_tokens: eventUsage.cacheRead || eventUsage.cache_read_tokens || 0,
            cache_write_tokens: eventUsage.cacheWrite || eventUsage.cache_write_tokens || 0,
          },
          cost = eventUsage.cost || {},
          costUsd = cost.total || eventUsage.cost_usd || 0,
          hasUsage =
            normalizedUsage.input_tokens ||
            normalizedUsage.output_tokens ||
            normalizedUsage.cache_read_tokens ||
            normalizedUsage.cache_write_tokens ||
            costUsd,
          usageKey =
            message.responseId ||
            event.responseId ||
            [
              normalizedUsage.input_tokens,
              normalizedUsage.output_tokens,
              normalizedUsage.cache_read_tokens,
              normalizedUsage.cache_write_tokens,
              eventUsage.totalTokens || eventUsage.total_tokens || 0,
              costUsd,
            ].join(':');
        if (hasUsage && !seenUsage.has(usageKey)) {
          seenUsage.add(usageKey);
          usage.input_tokens += normalizedUsage.input_tokens;
          usage.output_tokens += normalizedUsage.output_tokens;
          usage.cache_read_tokens += normalizedUsage.cache_read_tokens;
          usage.cache_write_tokens += normalizedUsage.cache_write_tokens;
          usageClassifications.push({
            responseId: message.responseId || event.responseId || null,
            activeTokens: normalizedUsage.input_tokens + normalizedUsage.output_tokens,
            hasAssistantAnswerText,
          });
          usage.cost_usd += costUsd;
        }
      }

      if (assistantText) {
        const responseId = message.responseId || event.responseId;
        if (responseId) {
          assistantByResponse.set(responseId, assistantText);
        } else {
          assistantParts.push(assistantText);
        }
      }

      if (type === 'message_end' && message.role === 'assistant') {
        behavior.assistant_turns++;
      }

      if (type === 'tool_execution_start') {
        const toolName = event.toolName || event.name || event.tool || event.tool_name || event.input?.tool;
        countTool(toolName);
        behavior.tool_calls++;
        if (toolName && /^memory-/.test(toolName)) {
          behavior.memory_tool_calls++;
        }
        if (toolName === 'memory-code' || toolName === 'read' || toolName === 'bash') {
          behavior.code_tool_calls++;
        }
      }

      if (type === 'tool_execution_end') {
        const isError = event.isError === true || event.result?.isError === true;
        if (isError) {
          behavior.failed_tool_calls++;
        }
      }

      if (
        message.stopReason === 'error' ||
        message.errorMessage ||
        (type === 'auto_retry_end' && event.success === false)
      ) {
        behavior.error_events++;
      }
    }
}
  }

  usage.active_tokens = usage.input_tokens + usage.output_tokens;
  usage.effective_tokens = usage.active_tokens + usage.cache_read_tokens;
  usage.cache_discounted_tokens = Math.round(usage.active_tokens + usage.cache_read_tokens * CACHE_READ_TOKEN_WEIGHT);
  usage.total_tokens = usage.effective_tokens;
  const answerParts =
      assistantByResponse.size > 0 ? [...assistantByResponse.values(), ...assistantParts] : assistantParts,
    answerResponseIds = new Set(
      [...assistantByResponse.entries()].filter(([, text]) => text.trim().length > 0).map(([responseId]) => responseId),
    ),
    usageResponseIds = new Set(
      usageClassifications.map((usageClassification) => usageClassification.responseId).filter(Boolean),
    ),
  result = (() => {

    behavior.missing_answer_usage_responses = [...answerResponseIds].filter(
      (responseId) => !usageResponseIds.has(responseId),
    ).length;
    for (const usageClassification of usageClassifications) {
      const isAnswerUsage = usageClassification.responseId
        ? answerResponseIds.has(usageClassification.responseId)
        : usageClassification.hasAssistantAnswerText;
      if (isAnswerUsage) {
        usage.answer_active_tokens += usageClassification.activeTokens;
      } else {
        usage.setup_active_tokens += usageClassification.activeTokens;
      }
    }
    
  return ({
    usage,
    answer: answerParts.join('\n').trim() || (parsedEvents === 0 ? raw.trim() : ''),
    tool_counts: Object.fromEntries(toolCounts.entries()),
    behavior: {
      ...behavior,
      tool_names: toolNames,
    },
  });
})();if (parsedEvents > 0 && answerParts.length === 0 && assistantByResponse.size === 0 && behavior.error_events > 0) {
    result.parse_warning = 'Pi events contained errors and no assistant answer';
  } else if (
    answerParts.length === 0 &&
    assistantByResponse.size === 0 &&
    seenUsage.size === 0 &&
    raw.trim().length > 0
  ) {
    result.parse_warning = 'No valid Pi events found in output';
  }
  return result;
function countTool(name) {
    if (name) {
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      toolNames.push(name);
    }
  }
}

function gradeAnswer(answer, expectedFacts) {
  const normalized = answer.toLowerCase(),
    facts = expectedFacts.map((fact) => {
      const aliases = fact.aliases || [fact.description],
        matched_aliases = aliases.filter((alias) => normalized.includes(String(alias).toLowerCase()));
      return {
        id: fact.id,
        description: fact.description,
        matched: matched_aliases.length > 0,
        matched_aliases,
      };
    }),
    matched = facts.filter((fact) => fact.matched).length;
  return {
    matched,
    total: facts.length,
    score: facts.length > 0 ? matched / facts.length : 0,
    facts,
  };
}

async function runSide(side, commandTemplate, task, repo, outDir, cwd, timeoutMs) {
  const outFile = path.join(outDir, `${task.id}.${side}.jsonl`),
    command = renderCommand(commandTemplate, task, repo, outFile);
  benchLog(`[bench] ${task.id}: starting ${side}`);
  {
const run = await runCommand(command, cwd, timeoutMs, outFile);
  benchLog(`[bench] ${task.id}: finished ${side} in ${run.elapsed_ms}ms`);
  if (run.status !== 0 && run.status != null) {
    if (!run.error) {
      run.error = `Command exited with status ${run.status}`;
    }
    benchLog(`[bench] WARNING: ${task.id} ${side}: command exited with status ${run.status}`);
  }

  let raw = '';
  if (fs.existsSync(outFile)) {
    raw = fs.readFileSync(outFile, 'utf-8');
  }
  if (!raw && (run.stdout || run.stderr)) {
    raw = `${run.stdout}\n${run.stderr}`;
  }

  {
const parsed = parsePiOutput(raw),
    grade = gradeAnswer(parsed.answer, task.expected_facts || []);

  return {
    side,
    command,
    output_file: outFile,
    status: run.status,
    signal: run.signal,
    elapsed_ms: run.elapsed_ms,
    error: run.error,
    usage: parsed.usage,
    tool_counts: parsed.tool_counts,
    behavior: parsed.behavior,
    grade,
  };
}
}
}

function printTableHeader(taskColumnWidth) {
  const columns = [
      'Task'.padEnd(taskColumnWidth),
      'OffFacts'.padEnd(9),
      'OnFacts'.padEnd(9),
      'OffActive'.padStart(10),
      'OnActive'.padStart(10),
      'ActSave'.padStart(8),
      'OffAdj'.padStart(10),
      'OnAdj'.padStart(10),
      'AdjSave'.padStart(8),
      'OffEff'.padStart(10),
      'OnEff'.padStart(10),
      'EffSave'.padStart(8),
      'OffAns'.padStart(8),
      'OnAns'.padStart(8),
      'AnsSave'.padStart(8),
      'OnSetup'.padStart(8),
      'OffMs'.padStart(9),
      'OnMs'.padStart(9),
    ],
    header = columns.join('  ');
  benchLog(header);
  benchLog('-'.repeat(header.length));
}

function printRow(taskId, off, on, taskColumnWidth) {
  const offTokens = off.usage.active_tokens || 0,
    onTokens = on.usage.active_tokens || 0,
    offAdjusted = off.usage.cache_discounted_tokens || 0,
    onAdjusted = on.usage.cache_discounted_tokens || 0,
    offEffective = off.usage.effective_tokens || off.usage.total_tokens || 0,
    onEffective = on.usage.effective_tokens || on.usage.total_tokens || 0,
    offAnswer = off.usage.answer_active_tokens || 0,
    onAnswer = on.usage.answer_active_tokens || 0,
    onSetup = on.usage.setup_active_tokens || 0,
    savings = offTokens > 0 ? `${Math.round((1 - onTokens / offTokens) * 100)}%` : 'n/a',
    adjustedSavings = offAdjusted > 0 ? `${Math.round((1 - onAdjusted / offAdjusted) * 100)}%` : 'n/a',
    effectiveSavings = offEffective > 0 ? `${Math.round((1 - onEffective / offEffective) * 100)}%` : 'n/a',
    answerSavings = offAnswer > 0 ? `${Math.round((1 - onAnswer / offAnswer) * 100)}%` : 'n/a',
    offScore = `${off.grade.matched}/${off.grade.total}`,
    onScore = `${on.grade.matched}/${on.grade.total}`,
    statusSuffix =
      off.status !== 0 && off.status != null && on.status !== 0 && on.status != null
        ? `  [off:${off.status} on:${on.status}]`
        : '';
  benchLog(
    [
      taskId.padEnd(taskColumnWidth),
      offScore.padEnd(9),
      onScore.padEnd(9),
      String(offTokens).padStart(10),
      String(onTokens).padStart(10),
      savings.padStart(8),
      String(offAdjusted).padStart(10),
      String(onAdjusted).padStart(10),
      adjustedSavings.padStart(8),
      String(offEffective).padStart(10),
      String(onEffective).padStart(10),
      effectiveSavings.padStart(8),
      String(offAnswer).padStart(8),
      String(onAnswer).padStart(8),
      answerSavings.padStart(8),
      String(onSetup).padStart(8),
      String(off.elapsed_ms).padStart(9),
      String(on.elapsed_ms).padStart(9),
    ].join('  ') + statusSuffix,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2)),
    taskPack = JSON.parse(fs.readFileSync(args.tasks, 'utf-8')),
    repo = taskPack.repo || path.basename(process.cwd()),
    tasks = (taskPack.tasks || []).filter((task) => !args.only || task.id === args.only),
  outDir = (() => {

    if (tasks.length === 0) {
      console.error(`No tasks matched ${args.only || args.tasks}`);
      process.exit(2);
    }
  
    
  return (path.resolve(args.outDir));
})();fs.mkdirSync(outDir, { recursive: true });
  {
const noMemoryHome = prepareNoMemoryHome(outDir),
    offCommand = process.env.BENCH_PI_MEMORY_OFF_CMD || defaultPiCommand(noMemoryHome),
    onCommand = process.env.BENCH_PI_MEMORY_ON_CMD || defaultPiCommand();

  benchLog(`[bench] memory-off HOME: ${noMemoryHome}`);
  if (!process.env.BENCH_PI_MEMORY_OFF_CMD || !process.env.BENCH_PI_MEMORY_ON_CMD) {
    benchLog('[bench] using default Pi commands; set BENCH_PI_MEMORY_OFF_CMD / BENCH_PI_MEMORY_ON_CMD to override');
  }
  benchLog('');
  {
const results = [],
    taskColumnWidth = Math.max(24, ...tasks.map((task) => task.id.length));
  printTableHeader(taskColumnWidth);
  for (const task of tasks) {
    const taskOutDir = path.join(outDir, task.id);
    fs.mkdirSync(taskOutDir, { recursive: true });
    // Sequential runs keep memory-off and memory-on from sharing live Pi state.
    // eslint-disable-next-line no-await-in-loop
    {
const off = await runSide('memory-off', offCommand, task, repo, taskOutDir, process.cwd(), args.timeoutMs),
      // eslint-disable-next-line no-await-in-loop
      on = await runSide('memory-on', onCommand, task, repo, taskOutDir, process.cwd(), args.timeoutMs);
    results.push({
      task_id: task.id,
      category: task.category || 'uncategorized',
      intent: task.intent || null,
      prompt: task.prompt,
      memory_off: off,
      memory_on: on,
    });
    printRow(task.id, off, on, taskColumnWidth);
  }
}

  {
const allFailed = results.every(
    (r) =>
      r.memory_off.status !== 0 &&
      r.memory_off.status != null &&
      r.memory_on.status !== 0 &&
      r.memory_on.status != null,
  );
  if (allFailed) {
    benchLog('\n[bench] ERROR: All tasks failed. Are Pi commands available?');
    benchLog(`[bench]   Off command: ${offCommand}`);
    benchLog(`[bench]   On command:  ${onCommand}`);
    process.exit(1);
  }

  {
const summary = buildSummary(results),
    report = {
      generated_at: new Date().toISOString(),
      host: os.hostname(),
      task_pack: args.tasks,
      summary,
      results,
    },
    reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  benchLog('\nSummary');
  benchLog(`  Tasks:             ${summary.tasks}`);
  benchLog(`  Memory-off facts:  ${summary.memory_off_facts}`);
  benchLog(`  Memory-on facts:   ${summary.memory_on_facts}`);
  benchLog(`  Memory-off active: ${summary.memory_off_active_tokens}`);
  benchLog(`  Memory-on active:  ${summary.memory_on_active_tokens}`);
  benchLog(`  Memory-off cache:  ${summary.memory_off_cache_read_tokens}`);
  benchLog(`  Memory-on cache:   ${summary.memory_on_cache_read_tokens}`);
  benchLog(`  Memory-off effect: ${summary.memory_off_effective_tokens}`);
  benchLog(`  Memory-on effect:  ${summary.memory_on_effective_tokens}`);
  benchLog(`  Memory-off adj:    ${summary.memory_off_cache_discounted_tokens}`);
  benchLog(`  Memory-on adj:     ${summary.memory_on_cache_discounted_tokens}`);
  benchLog(`  Memory-off answer: ${summary.memory_off_answer_active_tokens}`);
  benchLog(`  Memory-on answer:  ${summary.memory_on_answer_active_tokens}`);
  benchLog(`  Memory-off setup:  ${summary.memory_off_setup_active_tokens}`);
  benchLog(`  Memory-on setup:   ${summary.memory_on_setup_active_tokens}`);
  benchLog(`  Memory-off cost:   ${summary.memory_off_cost_usd.toFixed(6)}`);
  benchLog(`  Memory-on cost:    ${summary.memory_on_cost_usd.toFixed(6)}`);
  benchLog(`  Memory-off tools:  ${summary.memory_off_tool_calls} (${summary.memory_off_failed_tool_calls} failed)`);
  benchLog(`  Memory-on tools:   ${summary.memory_on_tool_calls} (${summary.memory_on_failed_tool_calls} failed)`);
  benchLog(`  Memory-on memtools:${summary.memory_on_memory_tool_calls}`);
  benchLog(`  Memory-on codetools:${summary.memory_on_code_tool_calls}`);
  benchLog(`  Memory-on turns:   ${summary.memory_on_assistant_turns}`);
  benchLog(`  Active delta:      ${summary.token_savings_pct}`);
  benchLog(`  Adjusted delta:    ${summary.cache_discounted_token_savings_pct}`);
  benchLog(`  Effective delta:   ${summary.effective_token_savings_pct}`);
  benchLog(`  Answer delta:      ${summary.answer_token_savings_pct}`);
  benchLog(`  Cost delta:        ${summary.cost_savings_pct}`);
  benchLog('');
  benchLog('By category:');
  for (const category of summary.categories) {
    benchLog(
      `  ${category.category}: facts ${category.memory_off_facts} -> ${category.memory_on_facts}, active ${category.memory_off_active_tokens} -> ${category.memory_on_active_tokens} (${category.token_savings_pct}), adjusted ${category.memory_off_cache_discounted_tokens} -> ${category.memory_on_cache_discounted_tokens} (${category.cache_discounted_token_savings_pct}), effective ${category.memory_off_effective_tokens} -> ${category.memory_on_effective_tokens} (${category.effective_token_savings_pct}), answer ${category.memory_off_answer_active_tokens} -> ${category.memory_on_answer_active_tokens} (${category.answer_token_savings_pct}), on-setup ${category.memory_on_setup_active_tokens}`,
    );
  }
  benchLog(`  Report:            ${reportPath}`);
}
}
}
}
}

function buildSummary(results) {
  const sum = results.reduce(
    (acc, result) => {
      acc.tasks++;
      acc.offMatched += result.memory_off.grade.matched;
      acc.offTotal += result.memory_off.grade.total;
      acc.onMatched += result.memory_on.grade.matched;
      acc.onTotal += result.memory_on.grade.total;
      acc.offTokens += result.memory_off.usage.active_tokens || 0;
      acc.onTokens += result.memory_on.usage.active_tokens || 0;
      acc.offCache += result.memory_off.usage.cache_read_tokens || 0;
      acc.onCache += result.memory_on.usage.cache_read_tokens || 0;
      acc.offEffectiveTokens += result.memory_off.usage.effective_tokens || result.memory_off.usage.total_tokens || 0;
      acc.onEffectiveTokens += result.memory_on.usage.effective_tokens || result.memory_on.usage.total_tokens || 0;
      acc.offCacheDiscountedTokens += result.memory_off.usage.cache_discounted_tokens || 0;
      acc.onCacheDiscountedTokens += result.memory_on.usage.cache_discounted_tokens || 0;
      acc.offAnswerTokens += result.memory_off.usage.answer_active_tokens || 0;
      acc.onAnswerTokens += result.memory_on.usage.answer_active_tokens || 0;
      acc.offSetupTokens += result.memory_off.usage.setup_active_tokens || 0;
      acc.onSetupTokens += result.memory_on.usage.setup_active_tokens || 0;
      acc.offCostUsd += result.memory_off.usage.cost_usd || 0;
      acc.onCostUsd += result.memory_on.usage.cost_usd || 0;
      acc.offElapsed += result.memory_off.elapsed_ms || 0;
      acc.onElapsed += result.memory_on.elapsed_ms || 0;
      acc.offToolCalls += result.memory_off.behavior?.tool_calls || 0;
      acc.onToolCalls += result.memory_on.behavior?.tool_calls || 0;
      acc.offFailedToolCalls += result.memory_off.behavior?.failed_tool_calls || 0;
      acc.onFailedToolCalls += result.memory_on.behavior?.failed_tool_calls || 0;
      acc.offMemoryToolCalls += result.memory_off.behavior?.memory_tool_calls || 0;
      acc.onMemoryToolCalls += result.memory_on.behavior?.memory_tool_calls || 0;
      acc.offCodeToolCalls += result.memory_off.behavior?.code_tool_calls || 0;
      acc.onCodeToolCalls += result.memory_on.behavior?.code_tool_calls || 0;
      acc.offAssistantTurns += result.memory_off.behavior?.assistant_turns || 0;
      acc.onAssistantTurns += result.memory_on.behavior?.assistant_turns || 0;
      return acc;
    },
    {
      tasks: 0,
      offMatched: 0,
      offTotal: 0,
      onMatched: 0,
      onTotal: 0,
      offTokens: 0,
      onTokens: 0,
      offCache: 0,
      onCache: 0,
      offEffectiveTokens: 0,
      onEffectiveTokens: 0,
      offCacheDiscountedTokens: 0,
      onCacheDiscountedTokens: 0,
      offAnswerTokens: 0,
      onAnswerTokens: 0,
      offSetupTokens: 0,
      onSetupTokens: 0,
      offCostUsd: 0,
      onCostUsd: 0,
      offElapsed: 0,
      onElapsed: 0,
      offToolCalls: 0,
      onToolCalls: 0,
      offFailedToolCalls: 0,
      onFailedToolCalls: 0,
      offMemoryToolCalls: 0,
      onMemoryToolCalls: 0,
      offCodeToolCalls: 0,
      onCodeToolCalls: 0,
      offAssistantTurns: 0,
      onAssistantTurns: 0,
    },
  );
  return {
    tasks: sum.tasks,
    memory_off_facts: `${sum.offMatched}/${sum.offTotal}`,
    memory_on_facts: `${sum.onMatched}/${sum.onTotal}`,
    memory_off_active_tokens: sum.offTokens,
    memory_on_active_tokens: sum.onTokens,
    memory_off_cache_read_tokens: sum.offCache,
    memory_on_cache_read_tokens: sum.onCache,
    memory_off_effective_tokens: sum.offEffectiveTokens,
    memory_on_effective_tokens: sum.onEffectiveTokens,
    memory_off_cache_discounted_tokens: sum.offCacheDiscountedTokens,
    memory_on_cache_discounted_tokens: sum.onCacheDiscountedTokens,
    memory_off_answer_active_tokens: sum.offAnswerTokens,
    memory_on_answer_active_tokens: sum.onAnswerTokens,
    memory_off_setup_active_tokens: sum.offSetupTokens,
    memory_on_setup_active_tokens: sum.onSetupTokens,
    memory_off_cost_usd: sum.offCostUsd,
    memory_on_cost_usd: sum.onCostUsd,
    memory_off_elapsed_ms: sum.offElapsed,
    memory_on_elapsed_ms: sum.onElapsed,
    memory_off_tool_calls: sum.offToolCalls,
    memory_on_tool_calls: sum.onToolCalls,
    memory_off_failed_tool_calls: sum.offFailedToolCalls,
    memory_on_failed_tool_calls: sum.onFailedToolCalls,
    memory_off_memory_tool_calls: sum.offMemoryToolCalls,
    memory_on_memory_tool_calls: sum.onMemoryToolCalls,
    memory_off_code_tool_calls: sum.offCodeToolCalls,
    memory_on_code_tool_calls: sum.onCodeToolCalls,
    memory_off_assistant_turns: sum.offAssistantTurns,
    memory_on_assistant_turns: sum.onAssistantTurns,
    token_savings_pct: sum.offTokens > 0 ? `${((1 - sum.onTokens / sum.offTokens) * 100).toFixed(1)}%` : 'n/a',
    effective_token_savings_pct:
      sum.offEffectiveTokens > 0
        ? `${((1 - sum.onEffectiveTokens / sum.offEffectiveTokens) * 100).toFixed(1)}%`
        : 'n/a',
    cache_discounted_token_savings_pct:
      sum.offCacheDiscountedTokens > 0
        ? `${((1 - sum.onCacheDiscountedTokens / sum.offCacheDiscountedTokens) * 100).toFixed(1)}%`
        : 'n/a',
    answer_token_savings_pct:
      sum.offAnswerTokens > 0 ? `${((1 - sum.onAnswerTokens / sum.offAnswerTokens) * 100).toFixed(1)}%` : 'n/a',
    cost_savings_pct: sum.offCostUsd > 0 ? `${((1 - sum.onCostUsd / sum.offCostUsd) * 100).toFixed(1)}%` : 'n/a',
    categories: buildCategorySummary(results),
  };
}

function buildCategorySummary(results) {
  const groups = new Map();
  for (const result of results) {
    const category = result.category || 'uncategorized',
    group = (() => {

      if (!groups.has(category)) {
        groups.set(category, {
          category,
          tasks: 0,
          offMatched: 0,
          offTotal: 0,
          onMatched: 0,
          onTotal: 0,
          offTokens: 0,
          onTokens: 0,
          offCache: 0,
          onCache: 0,
          offEffectiveTokens: 0,
          onEffectiveTokens: 0,
          offCacheDiscountedTokens: 0,
          onCacheDiscountedTokens: 0,
          offAnswerTokens: 0,
          onAnswerTokens: 0,
          offSetupTokens: 0,
          onSetupTokens: 0,
        });
      }
      
  return (groups.get(category));
})();group.tasks++;
    group.offMatched += result.memory_off.grade.matched;
    group.offTotal += result.memory_off.grade.total;
    group.onMatched += result.memory_on.grade.matched;
    group.onTotal += result.memory_on.grade.total;
    group.offTokens += result.memory_off.usage.active_tokens || 0;
    group.onTokens += result.memory_on.usage.active_tokens || 0;
    group.offCache += result.memory_off.usage.cache_read_tokens || 0;
    group.onCache += result.memory_on.usage.cache_read_tokens || 0;
    group.offEffectiveTokens += result.memory_off.usage.effective_tokens || result.memory_off.usage.total_tokens || 0;
    group.onEffectiveTokens += result.memory_on.usage.effective_tokens || result.memory_on.usage.total_tokens || 0;
    group.offCacheDiscountedTokens += result.memory_off.usage.cache_discounted_tokens || 0;
    group.onCacheDiscountedTokens += result.memory_on.usage.cache_discounted_tokens || 0;
    group.offAnswerTokens += result.memory_off.usage.answer_active_tokens || 0;
    group.onAnswerTokens += result.memory_on.usage.answer_active_tokens || 0;
    group.offSetupTokens += result.memory_off.usage.setup_active_tokens || 0;
    group.onSetupTokens += result.memory_on.usage.setup_active_tokens || 0;
  }

  return [...groups.values()].map((group) => ({
    category: group.category,
    tasks: group.tasks,
    memory_off_facts: `${group.offMatched}/${group.offTotal}`,
    memory_on_facts: `${group.onMatched}/${group.onTotal}`,
    memory_off_active_tokens: group.offTokens,
    memory_on_active_tokens: group.onTokens,
    memory_off_cache_read_tokens: group.offCache,
    memory_on_cache_read_tokens: group.onCache,
    memory_off_effective_tokens: group.offEffectiveTokens,
    memory_on_effective_tokens: group.onEffectiveTokens,
    memory_off_cache_discounted_tokens: group.offCacheDiscountedTokens,
    memory_on_cache_discounted_tokens: group.onCacheDiscountedTokens,
    memory_off_answer_active_tokens: group.offAnswerTokens,
    memory_on_answer_active_tokens: group.onAnswerTokens,
    memory_off_setup_active_tokens: group.offSetupTokens,
    memory_on_setup_active_tokens: group.onSetupTokens,
    token_savings_pct: group.offTokens > 0 ? `${((1 - group.onTokens / group.offTokens) * 100).toFixed(1)}%` : 'n/a',
    effective_token_savings_pct:
      group.offEffectiveTokens > 0
        ? `${((1 - group.onEffectiveTokens / group.offEffectiveTokens) * 100).toFixed(1)}%`
        : 'n/a',
    cache_discounted_token_savings_pct:
      group.offCacheDiscountedTokens > 0
        ? `${((1 - group.onCacheDiscountedTokens / group.offCacheDiscountedTokens) * 100).toFixed(1)}%`
        : 'n/a',
    answer_token_savings_pct:
      group.offAnswerTokens > 0 ? `${((1 - group.onAnswerTokens / group.offAnswerTokens) * 100).toFixed(1)}%` : 'n/a',
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  buildCategorySummary,
  buildSummary,
  gradeAnswer,
  parsePiOutput,
};
function parseArgs(argv) {
  const args = {
    tasks: DEFAULT_TASKS,
    outDir: path.join('bench', 'results', `pi-paired-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    only: null,
    timeoutMs: 10 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tasks') {
      args.tasks = argv[++i];
    } else if (arg === '--out-dir') {
      args.outDir = argv[++i];
    } else if (arg === '--only') {
      args.only = argv[++i];
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = parseInt(argv[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}
function printHelp() {
  console.log(`Usage:
  node bench/bench-pi-paired.js

By default, this runs:
  1. memory off: Pi with a temporary HOME that copies only config/auth files
  2. memory on:  Pi from your normal HOME

Command templates may use:
  {prompt}   shell-quoted benchmark prompt
  {task_id}  task id
  {repo}     repo name from the fixture
  {out}      shell-quoted output file path

Options:
  --only TASK_ID       Run one task
  --timeout-ms N       Per-side timeout, default 600000

Override example:
  BENCH_PI_MEMORY_OFF_CMD='pi --print --mode json --no-session {prompt} > {out} 2>&1' \\
  BENCH_PI_MEMORY_ON_CMD='pi --print --mode json --no-session {prompt} > {out} 2>&1' \\
  node bench/bench-pi-paired.js`);
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function renderCommand(template, task, repo, outFile) {
  return template
    .replaceAll('{prompt}', shellQuote(task.prompt))
    .replaceAll('{task_id}', task.id)
    .replaceAll('{repo}', repo)
    .replaceAll('{out}', shellQuote(outFile));
}
function defaultPiCommand(homeDir = null) {
  const homePrefix = homeDir ? `HOME=${shellQuote(homeDir)} ` : '';
  return `${homePrefix}pi --print --mode json --no-session {prompt} > {out} 2>&1`;
}
function prepareNoMemoryHome(outDir) {
  const sourceAgentDir = path.join(os.homedir(), '.pi', 'agent'),
    homeDir = path.join(outDir, '.pi-memory-off-home'),
    targetAgentDir = path.join(homeDir, '.pi', 'agent');
  fs.mkdirSync(targetAgentDir, { recursive: true });

  for (const file of PI_CONFIG_FILES) {
    const source = path.join(sourceAgentDir, file);
    if (fs.existsSync(source)) {
      const target = path.join(targetAgentDir, file);
      if (file === 'settings.json') {
        fs.writeFileSync(target, `${JSON.stringify(sanitizeMemoryOffSettings(source), null, 2)}\n`);
      } else {
        fs.copyFileSync(source, target);
      }
    }
  }

  return homeDir;
}
function sanitizeMemoryOffSettings(settingsPath) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  for (const key of MEMORY_OFF_EMPTY_SETTINGS) {
    if (Array.isArray(settings[key])) {
      settings[key] = [];
    }
  }
  return settings;
}
