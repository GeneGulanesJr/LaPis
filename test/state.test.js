import { state, getTimeout, trustIcon, isCodeFile } from '../extensions/memory-layer/state.ts';

describe('state', () => {
  it('should export a state object with expected keys', () => {
    expect(state).toHaveProperty('nativeChecked');
    expect(state).toHaveProperty('cachedRepos');
    expect(state).toHaveProperty('repoCacheTime');
    expect(state).toHaveProperty('sessionId');
    expect(state).toHaveProperty('currentProject');
    expect(state).toHaveProperty('memoriesSavedThisSession');
    expect(state).toHaveProperty('nudgeCountThisSession');
    expect(state).toHaveProperty('exploredFiles');
    expect(state).toHaveProperty('turnCount');
    expect(state).toHaveProperty('llmCallCount');
    expect(state).toHaveProperty('lastMemoryToolCall');
    expect(state).toHaveProperty('lastAutoDecisionSave');
    expect(state).toHaveProperty('hasInjectedContext');
    expect(state).toHaveProperty('editedFiles');
  });

  it('should have mutable state fields', () => {
    state.turnCount = 5;
    expect(state.turnCount).toBe(5);
    state.turnCount = 0;
  });
});

describe('state utilities', () => {
  describe('getTimeout', () => {
    it('should return default timeout for unknown commands', () => {
      expect(getTimeout('unknown')).toBe(15000);
    });

    it('should return specific timeout for known commands', () => {
      expect(getTimeout('dead-code')).toBe(60000);
      expect(getTimeout('index-repo')).toBe(120000);
      expect(getTimeout('cycles')).toBe(60000);
    });
  });

  describe('trustIcon', () => {
    it('should return warning icon for low trust', () => {
      expect(trustIcon(0.3)).toContain('⚠️');
    });

    it('should return search icon for medium trust', () => {
      expect(trustIcon(0.6)).toContain('🔎');
    });

    it('should return empty for high trust', () => {
      expect(trustIcon(0.9)).toBe('');
    });
  });

  describe('isCodeFile', () => {
    it('should recognize TypeScript files', () => {
      expect(isCodeFile('src/index.ts')).toBe(true);
      expect(isCodeFile('src/App.tsx')).toBe(true);
    });

    it('should recognize JavaScript files', () => {
      expect(isCodeFile('src/index.js')).toBe(true);
      expect(isCodeFile('src/App.jsx')).toBe(true);
    });

    it('should recognize Python files', () => {
      expect(isCodeFile('main.py')).toBe(true);
    });

    it('should not recognize markdown files', () => {
      expect(isCodeFile('README.md')).toBe(false);
    });

    it('should not recognize JSON files', () => {
      expect(isCodeFile('package.json')).toBe(false);
    });

    it('should handle uppercase extensions', () => {
      expect(isCodeFile('main.TS')).toBe(true);
    });
  });
});
