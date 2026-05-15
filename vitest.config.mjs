import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
  },
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    retry: 2,
    reporters: ['verbose'],
    // Test files share the same SQLite DB (~/.pi/memory/memory.db).
    // Parallel file execution causes race conditions when tests in
    // test/ and .worktrees/*/test/ try to create/remove the same repos
    // or reindex the same doc repos simultaneously.
    fileParallelism: false,
  },
});
