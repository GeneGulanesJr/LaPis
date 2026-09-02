/**
 * Regression test for: in-process gateway dispatch silently falling back to child process.
 *
 * Bug: `extensions/memory-layer/host/memory-client.ts` had `require('../../src/cli/gateway')`
 * which resolves to `extensions/memory-layer/src/cli/gateway.js` (wrong). The require
 * threw MODULE_NOT_FOUND, the empty `catch {}` swallowed the error, and
 * `_inProcessDispatch` stayed `null` forever — meaning every `mem()` call spawned a
 * child process via `execFile`, which is slow and can time out under load.
 *
 * Fix: corrected path to `require('../../../src/cli/gateway')` and replaced the silent
 * `catch {}` with a logged error so future path issues are visible.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

describe('memory-client in-process dispatch', () => {
  it('gateway.js exists at the corrected relative path from host/', () => {
    // Path: host/memory-client.ts → ../../../src/cli/gateway.js
    const hostDir = path.resolve(import.meta.dirname, '../extensions/memory-layer/host'),
      correct = path.resolve(hostDir, '../../../src/cli/gateway.js'),
      wrong = path.resolve(hostDir, '../../src/cli/gateway.js');
    expect(existsSync(correct)).toBe(true);
    expect(existsSync(wrong)).toBe(false);
  });

  it('source uses the corrected require path (no MODULE_NOT_FOUND at runtime)', () => {
    const memoryClientPath = path.resolve(import.meta.dirname, '../extensions/memory-layer/host/memory-client.ts'),
      source = readFileSync(memoryClientPath, 'utf8');

    // Must NOT use the broken 2-up path.
    expect(source).not.toMatch(/require\(['"]\.\.\/\.\.\/src\/cli\/gateway['"]\)/);
    // Must use the corrected 3-up path.
    expect(source).toMatch(/require\(['"]\.\.\/\.\.\/\.\.\/src\/cli\/gateway['"]\)/);
  });

  it('source does NOT have a silent empty catch around the gateway require', () => {
    // Defensive: the previous bug had a bare `catch {}` that swallowed the
    // Require error, making path issues invisible. Ensure we log the failure.
    const memoryClientPath = path.resolve(import.meta.dirname, '../extensions/memory-layer/host/memory-client.ts'),
      source = readFileSync(memoryClientPath, 'utf8'),
      // Look for the require + catch block specifically.
      requireMatch = source.match(/require\(['"]\.\.\/\.\.\/\.\.\/src\/cli\/gateway['"]\)/);
    expect(requireMatch).not.toBeNull();

    // The catch block surrounding the require must reference a logging call
    // (console.error). A bare `catch {}` is forbidden.
    // Allow either:
    //   } catch (e: unknown) { ... console.error ... }
    //   } catch { ... console.error ... }
    {
      const blockAfterRequire = source.slice(requireMatch!.index!),
        // Find the next `catch` keyword after the require.
        catchMatch = blockAfterRequire.match(/catch\s*(\(|\{)/);
      expect(catchMatch).not.toBeNull();
      // Extract a window after the catch and look for a logging call. Accept
      // Either a direct console.error or a call to the reportInProcessFailure()
      // Helper (which wraps console.error and de-dupes the message). The
      // Invariant is: the catch must NOT silently swallow the require error.
      {
        const catchIdx = requireMatch!.index! + catchMatch!.index!,
          catchWindow = source.slice(catchIdx, catchIdx + 400);
        expect(catchWindow).toMatch(/console\.error|reportInProcessFailure/);
        // And it must NOT be a bare `catch {}` immediately followed by a closing brace.
        expect(catchWindow).not.toMatch(/^catch\s*\{\s*\}/);
      }
    }
  });
});
