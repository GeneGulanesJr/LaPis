const COMMAND_RULES = [
  {
    patterns: [/^git\s+diff/],
    type: 'git-diff',
  },
  {
    patterns: [/^git\s+status/],
    type: 'git-status',
  },
  {
    patterns: [/^(npm|pnpm|yarn|bun)\s+test/, /^(vitest|jest|mocha|pytest|cargo\s+test|go\s+test)/],
    type: 'test',
  },
  {
    patterns: [/^(npm|pnpm|yarn|bun)\s+(install|i|ci|add)/],
    type: 'install',
  },
  {
    patterns: [/^cat\s/, /^bat\s/, /^type\s/, /^head\s/, /^tail\s+-n\s+\d+\s+/],
    type: 'file-read',
  },
  {
    patterns: [/^ls\s+/, /^tree\s?/, /^find\s/, /^dir\s/],
    type: 'list',
  },
  {
    patterns: [/^grep\s/, /^rg\s/, /^ag\s/, /^ack\s/, /^ripgrep\s/],
    type: 'search',
  },
  {
    patterns: [/^tail\s/, /^journalctl/, /^docker\s+logs/, /^pm2\s+logs/, /^kubectl\s+logs/],
    type: 'logs',
  },
];

function classifyCommand(commandArgs) {
  const cmd = commandArgs.join(' ');
  for (const rule of COMMAND_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(cmd)) {
        return rule.type;
      }
    }
  }
  return 'generic';
}

module.exports = { classifyCommand };
