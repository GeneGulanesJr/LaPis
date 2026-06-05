const { classifyCommand } = require('../src/token-saver/classify-command');

describe('classify-command', () => {
  it('classifies git diff', () => {
    expect(classifyCommand(['git', 'diff'])).toBe('git-diff');
    expect(classifyCommand(['git', 'diff', '--staged'])).toBe('git-diff');
    expect(classifyCommand(['git', 'diff', 'HEAD~1'])).toBe('git-diff');
  });

  it('classifies git status', () => {
    expect(classifyCommand(['git', 'status'])).toBe('git-status');
  });

  it('classifies test commands', () => {
    expect(classifyCommand(['npm', 'test'])).toBe('test');
    expect(classifyCommand(['pnpm', 'test'])).toBe('test');
    expect(classifyCommand(['yarn', 'test'])).toBe('test');
    expect(classifyCommand(['vitest'])).toBe('test');
    expect(classifyCommand(['jest'])).toBe('test');
    expect(classifyCommand(['pytest'])).toBe('test');
  });

  it('classifies install commands', () => {
    expect(classifyCommand(['npm', 'install'])).toBe('install');
    expect(classifyCommand(['pnpm', 'install'])).toBe('install');
    expect(classifyCommand(['npm', 'ci'])).toBe('install');
    expect(classifyCommand(['yarn', 'add', 'express'])).toBe('install');
  });

  it('classifies file-read commands', () => {
    expect(classifyCommand(['cat', 'file.txt'])).toBe('file-read');
    expect(classifyCommand(['bat', 'file.txt'])).toBe('file-read');
  });

  it('classifies list commands', () => {
    expect(classifyCommand(['ls', '-R'])).toBe('list');
    expect(classifyCommand(['tree'])).toBe('list');
    expect(classifyCommand(['find', '.'])).toBe('list');
  });

  it('classifies search commands', () => {
    expect(classifyCommand(['grep', 'TODO', '-R', '.'])).toBe('search');
    expect(classifyCommand(['rg', 'pattern'])).toBe('search');
  });

  it('classifies log commands', () => {
    expect(classifyCommand(['tail', '-f', 'log.txt'])).toBe('logs');
    expect(classifyCommand(['journalctl'])).toBe('logs');
    expect(classifyCommand(['docker', 'logs', 'container'])).toBe('logs');
  });

  it('returns generic for unknown commands', () => {
    expect(classifyCommand(['unknown', 'cmd'])).toBe('generic');
    expect(classifyCommand(['node', 'server.js'])).toBe('generic');
    expect(classifyCommand(['echo', 'hello'])).toBe('generic');
  });
});
