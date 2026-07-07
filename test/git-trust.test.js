const { GIT_TRUST_OP_RE, matchesGitTrustOperation } = require('../src/hooks-engine/git-trust');

describe('git trust operation matcher', () => {
  it('matches bare git pull', () => {
    expect(matchesGitTrustOperation('git pull origin main')).toBe(true);
  });

  it('matches compound commands', () => {
    expect(matchesGitTrustOperation('cd /proj && git pull')).toBe(true);
  });

  it('matches git -C with unquoted path', () => {
    expect(matchesGitTrustOperation('git -C /proj/app pull origin main')).toBe(true);
  });

  it('matches git -C with double-quoted path containing spaces', () => {
    expect(matchesGitTrustOperation('git -C "/path/with spaces" pull')).toBe(true);
  });

  it('matches git -C with single-quoted path', () => {
    expect(matchesGitTrustOperation("git -C '/path/with spaces' checkout main")).toBe(true);
  });

  it('does not match unrelated commands', () => {
    expect(matchesGitTrustOperation('npm install')).toBe(false);
    expect(matchesGitTrustOperation('git status')).toBe(false);
  });

  it('exports the regex for legacy tests', () => {
    expect(GIT_TRUST_OP_RE).toBeInstanceOf(RegExp);
  });
});
