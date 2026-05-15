## Description

<!-- What does this PR do? Link to relevant issues. -->

Fixes #

## Extraction Checklist

<!-- For PRs touching extraction/modularization code (labeled `architecture` or `refactor`).
     These checks MUST pass before merge. -->

- [ ] Full test suite passes locally: `npm test`
- [ ] Smoke CLI tests pass: `node test/smoke-cli.js`
- [ ] Lint passes: `npm run lint`
- [ ] No regressions in existing test behavior
- [ ] If a test behavior change was legitimate, it is documented below

### Legitimate Test Behavior Changes

<!-- If any existing test changed its expected behavior, document why here.
     Example: "Updated test XYZ because the command now returns a typed result
     instead of a raw CLI envelope." -->

## Documentation Checklist

- [ ] Documentation updated if behavior, commands, or architecture changed
- [ ] `docs/MODULE_MAP.md` updated if modules were added, removed, renamed, or had entry points changed

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring (no functional change)
- [ ] Documentation
- [ ] CI/CD

## How Has This Been Tested?

<!-- Describe how you verified the changes. -->
