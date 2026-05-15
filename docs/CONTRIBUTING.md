# Contributing to LaPis

## Baseline Verification Commands

Run these from a clean checkout to verify the codebase is healthy:

```bash
# 1. Run the full test suite (vitest)
npm test

# 2. Run smoke CLI tests (every CLI command as subprocess)
node test/smoke-cli.js

# 3. Lint and format checks
npm run check
```

All three must pass before any PR is merged.

## Extraction PRs

PRs labeled `architecture` or `refactor` that touch modularization code (issues #75–#84) have additional requirements:

1. **Full test suite must pass** — no exceptions.
2. **Smoke CLI tests must pass** — every command that moved to a new router must still work.
3. **Legitimate test changes must be documented** — if an extraction causes a test's expected behavior to change, update the test in the same PR and explain in the PR description.

## Test Commands Reference

| Command | What it checks | When to run |
|---|---|---|
| `npm test` | Full vitest suite (unit + integration) | Every PR |
| `node test/smoke-cli.js` | Every CLI subcommand via subprocess | Every extraction PR |
| `npm run lint` | oxlint static analysis | Every PR |
| `npm run format:check` | oxfmt formatting check | Every PR |
| `npm run check` | Lint + format combined | Every PR |

## CI

GitHub Actions runs on every push and PR to `main`:

- **test.yml** — install, lint, full test suite, smoke CLI tests
- **crosshash-ci.yml** — Rust lint/test for `crosshash/` submodule

## Project Structure

```
memory-store.js          — CLI entry point (delegates to cli.js)
extensions/
  memory-layer/          — Pi extension (composition root)
    host/                — Memory client, project detector, repo cache
    hooks/               — Session lifecycle, context injection, passive capture
    tools/               — Memory tools, code tools, doc tools
src/                     — (Post-extraction) Feature domains
  memory-domain/
  workflow-memory/
  code-index/
  code-analysis/
  doc-index/
  trust-sync/
  platform/protocol/
  cli/commands/
test/                    — Vitest unit/integration tests
  smoke-cli.js           — CLI subprocess smoke tests
```
