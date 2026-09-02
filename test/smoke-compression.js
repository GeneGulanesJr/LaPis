/**
 * Smoke test: simulates Pi's ExtensionAPI to verify the hook wires up correctly.
 * Run with: npx tsx test/smoke-compression.js
 */
const { registerOutputCompression } = require('../extensions/memory-layer/hooks/output-compression.js'),
  // ---- Minimal ExtensionAPI mock ----
  handlers = {},
  mockPi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
  },
  // ---- Minimal state ----
  state = {
    compressionStats: {
      totalRuns: 0,
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      totalSavedTokens: 0,
    },
  };

// ---- Minimal getConfig ----
function getConfig() {
  try {
    return require('../config.js').getConfig();
  } catch {
    return {};
  }
}

// ---- Run smoke test ----
async function runSmokeTest() {
  console.log('🔥 Output Compression Hook — Smoke Test\n');

  let passed = 0,
    failed = 0;

  function assert(condition, label) {
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label}`);
      failed++;
    }
  }

  // 1. Register the hook
  console.log('1. Registering hook...');
  try {
    registerOutputCompression(mockPi, { state, getConfig });
    assert(true, 'Hook registration did not throw');
  } catch (e) {
    assert(false, `Hook registration threw: ${e.message}`);
  }

  // 2. Verify tool_result handler was registered
  console.log('\n2. Checking handler registration...');
  assert(handlers['tool_result'] !== undefined, 'tool_result handler is registered');

  const handler = handlers['tool_result'];

  // 3. Non-bash tool — should be skipped
  console.log('\n3. Non-bash tool (should be skipped)...');
  {
    const readResult = await handler(
      {
        type: 'tool_result',
        toolName: 'read',
        toolCallId: 'call-1',
        input: { path: '/foo.ts' },
        content: [{ type: 'text', text: 'file contents' }],
        details: undefined,
        isError: false,
      },
      {},
    );
    assert(readResult === undefined, 'Non-bash tool returned undefined (correct)');

    // 4. Short bash output — should be skipped
    console.log('\n4. Short bash output (should be skipped)...');
    {
      const shortResult = await handler(
        {
          type: 'tool_result',
          toolName: 'bash',
          toolCallId: 'call-2',
          input: { command: 'echo hi' },
          content: [{ type: 'text', text: 'hello world' }],
          details: undefined,
          isError: false,
        },
        {},
      );
      assert(shortResult === undefined, 'Short output returned undefined (correct)');

      // 5. Large bash output — should be compressed
      console.log('\n5. Large bash output (should be compressed)...');
      {
        const largeOutput = 'Test output line\n'.repeat(500),
          largeResult = await handler(
            {
              type: 'tool_result',
              toolName: 'bash',
              toolCallId: 'call-3',
              input: { command: 'npm test' },
              content: [{ type: 'text', text: largeOutput }],
              details: undefined,
              isError: false,
            },
            {},
          ),
          config = (() => {
            assert(largeResult !== undefined, 'Large output returned a result (correct)');
            assert(
              largeResult.content && largeResult.content[0] && largeResult.content[0].text,
              'Result has content with text',
            );
            assert(
              largeResult.content[0].text.startsWith('[Output compressed:'),
              'Result starts with compression prefix',
            );
            assert(
              largeResult.content[0].text.length < largeOutput.length,
              `Output was compressed (${largeResult.content[0].text.length} < ${largeOutput.length})`,
            );

            // 6. Stats were updated
            console.log('\n6. Checking compression stats...');
            assert(state.compressionStats.totalRuns === 1, `totalRuns === 1 (got ${state.compressionStats.totalRuns})`);
            assert(state.compressionStats.totalOriginalTokens > 0, 'totalOriginalTokens > 0');
            assert(state.compressionStats.totalSavedTokens > 0, 'totalSavedTokens > 0');

            // 7. Config defaults
            console.log('\n7. Checking config defaults...');

            return getConfig();
          })();
        assert(config.output_compression !== undefined, 'output_compression key exists in config');
        assert(config.output_compression?.enabled === true, 'output_compression.enabled defaults to true');
        assert(config.output_compression?.min_chars === 2000, 'output_compression.min_chars defaults to 2000');
        assert(
          config.output_compression?.min_savings_percent === 30,
          'output_compression.min_savings_percent defaults to 30',
        );

        // Summary
        console.log(`\n${'='.repeat(40)}`);
        console.log(`Results: ${passed} passed, ${failed} failed`);
        if (failed > 0) {
          process.exit(1);
        }
        console.log('\n🎉 All smoke tests passed!\n');
      }
    }
  }
}

runSmokeTest().catch((e) => {
  console.error('Smoke test threw:', e);
  process.exit(1);
});
