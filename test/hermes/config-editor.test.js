const {
  upsertSubBlock,
  removeSubBlock,
  removeTopLevelBlock,
  removeEmptySubBlock,
  topBlockEmpty,
  upsertListItem,
  removeListItems,
  upsertScalar,
  removeScalar,
} = require('../../src/hermes/config-editor');

const COMMAND = '/usr/bin/node /lapis/memory-store.js hermes hook';

describe('config-editor: mcp_servers sub-blocks', () => {
  test('creates mcp_servers.lapis from scratch', () => {
    const text = 'model:\n  default: deepseek\n';
    const out = upsertSubBlock(text, 'mcp_servers', 'lapis', [
      'command: /usr/bin/node',
      'args:',
      '  - /lapis/memory-store.js',
      '  - mcp',
      'enabled: true',
    ]);
    expect(out).toContain('mcp_servers:');
    expect(out).toContain('  lapis:');
    expect(out).toContain('    command: /usr/bin/node');
    expect(out).toContain('    enabled: true');
    // Unrelated top-level keys survive untouched.
    expect(out).toContain('model:\n  default: deepseek');
  });

  test('adds lapis alongside an existing MCP server', () => {
    const text = 'mcp_servers:\n  time:\n    command: uvx\n    args:\n      - mcp-server-time\n';
    const out = upsertSubBlock(text, 'mcp_servers', 'lapis', [
      'command: /usr/bin/node',
      'args:',
      '  - /lapis/memory-store.js',
      '  - mcp',
      'enabled: true',
    ]);
    expect(out).toContain('  time:\n    command: uvx');
    expect(out).toContain('  lapis:\n    command: /usr/bin/node');
  });

  test('replaces an existing lapis entry (idempotent re-install)', () => {
    const text = 'mcp_servers:\n  lapis:\n    command: /old/node\n    enabled: true\n  time:\n    command: uvx\n';
    const out = upsertSubBlock(text, 'mcp_servers', 'lapis', [
      'command: /usr/bin/node',
      'args:',
      '  - /lapis/memory-store.js',
      '  - mcp',
      'enabled: true',
    ]);
    expect(out.match(/  lapis:/g)).toHaveLength(1);
    expect(out).toContain('    command: /usr/bin/node');
    expect(out).not.toContain('/old/node');
    expect(out).toContain('  time:\n    command: uvx');
  });

  test('removeSubBlock removes only the lapis entry', () => {
    const text = 'mcp_servers:\n  lapis:\n    command: /usr/bin/node\n    enabled: true\n  time:\n    command: uvx\n';
    const out = removeSubBlock(text, 'mcp_servers', 'lapis');
    expect(out).not.toContain('lapis');
    expect(out).toContain('  time:\n    command: uvx');
  });
});

describe('config-editor: hooks list items', () => {
  const item = ['- matcher: "^read_file$"', `  command: "${COMMAND}"`, '  timeout: 15'];

  test('creates hooks.pre_tool_call from scratch', () => {
    const text = 'model:\n  default: deepseek\n';
    const out = upsertListItem(text, 'hooks', 'pre_tool_call', item, COMMAND);
    expect(out).toContain('hooks:');
    expect(out).toContain('  pre_tool_call:');
    expect(out).toContain(`    - matcher: "^read_file$"`);
    expect(out).toContain(`      command: "${COMMAND}"`);
  });

  test('adds a second event under hooks without touching the first', () => {
    const text = 'hooks:\n  pre_tool_call:\n    - matcher: "^read_file$"\n      command: "A"\n      timeout: 15\n';
    const out = upsertListItem(text, 'hooks', 'on_session_end', ['- command: "B"', '  timeout: 20'], 'B');
    expect(out).toContain('    - matcher: "^read_file$"\n      command: "A"');
    expect(out).toContain('  on_session_end:\n    - command: "B"');
  });

  test('replaces an existing item with the same command marker', () => {
    const text = `hooks:\n  pre_tool_call:\n    - matcher: "^read_file$"\n      command: "${COMMAND}"\n      timeout: 5\n`;
    const out = upsertListItem(text, 'hooks', 'pre_tool_call', item, COMMAND);
    expect(out.match(/- matcher: "\^read_file\$"/g)).toHaveLength(1);
    expect(out).toContain('      timeout: 15');
    expect(out).not.toContain('timeout: 5');
  });

  test('preserves user hooks whose command differs from the marker', () => {
    const text = `hooks:\n  pre_tool_call:\n    - matcher: "^terminal$"\n      command: "/user/script.sh"\n      timeout: 10\n`;
    const out = upsertListItem(text, 'hooks', 'pre_tool_call', item, COMMAND);
    expect(out).toContain('"/user/script.sh"');
    expect(out).toContain(`command: "${COMMAND}"`);
    expect(out.match(/- matcher:/g)).toHaveLength(2);
  });

  test('removeListItems removes only items containing the marker', () => {
    const text = `hooks:\n  pre_tool_call:\n    - matcher: "^terminal$"\n      command: "/user/script.sh"\n      timeout: 10\n    - matcher: "^read_file$"\n      command: "${COMMAND}"\n      timeout: 15\n`;
    const out = removeListItems(text, 'hooks', 'pre_tool_call', COMMAND);
    expect(out).toContain('"/user/script.sh"');
    expect(out).not.toContain('read_file');
  });
});

describe('config-editor: scalars and top-level removal', () => {
  test('upsertScalar updates in place and appends when missing', () => {
    expect(upsertScalar('hooks_auto_accept: false\n', 'hooks_auto_accept', 'true')).toContain(
      'hooks_auto_accept: true',
    );
    const appended = upsertScalar('model:\n  default: x\n', 'hooks_auto_accept', 'true');
    expect(appended).toContain('model:\n  default: x');
    expect(appended).toContain('hooks_auto_accept: true');
  });

  test('removeScalar drops the line', () => {
    expect(removeScalar('hooks_auto_accept: true\nmodel:\n  x: y\n', 'hooks_auto_accept')).not.toContain(
      'hooks_auto_accept',
    );
  });

  test('removeTopLevelBlock removes an empty hooks block', () => {
    const out = removeTopLevelBlock('hooks:\n  pre_tool_call:\n    - command: "x"\n', 'hooks');
    expect(out).not.toContain('hooks:');
  });

  test('removeEmptySubBlock drops bare key headers left after item removal', () => {
    const text = 'hooks:\n  pre_tool_call:\n  on_session_end:\n    - command: "keep"\n      timeout: 20\n';
    const out = removeEmptySubBlock(text, 'hooks', 'pre_tool_call');
    expect(out).not.toContain('pre_tool_call:');
    expect(out).toContain('on_session_end:\n    - command: "keep"');
  });

  test('topBlockEmpty treats bare-key-only blocks as empty', () => {
    expect(topBlockEmpty('mcp_servers:\n  lapis:\n', 'mcp_servers')).toBe(true);
    expect(topBlockEmpty('mcp_servers:\n  lapis:\n    enabled: true\n', 'mcp_servers')).toBe(false);
    expect(topBlockEmpty('model:\n  x: y\n', 'mcp_servers')).toBe(false);
  });
});
