const COLLAPSE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  'target',
  '__pycache__',
  '.tox',
  'vendor',
  '.venv',
  'venv',
];

function compressListOutput({ stdout, stderr }) {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) {
    return {
      summary: 'No output.',
      importantOutput: '',
      omittedLines: 0,
    };
  }

  const lines = combined.split('\n'),
    sourceDirs = {},
    collapsed = {};
  let collapsedCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== '.') {
      let isCollapsed = false;
      for (const dir of COLLAPSE_DIRS) {
        if (trimmed.startsWith(`${dir}/`) || trimmed.startsWith(`${dir}\\`) || trimmed === dir) {
          if (!collapsed[dir]) {
            collapsed[dir] = 0;
          }
          collapsed[dir]++;
          collapsedCount++;
          isCollapsed = true;
          break;
        }
      }

      if (!isCollapsed) {
        const parts = trimmed.split(/[/\\]/),
          topDir = parts[0];
        if (!sourceDirs[topDir]) {
          sourceDirs[topDir] = 0;
        }
        sourceDirs[topDir]++;
      }
    }
  }

  let output = 'Directory summary:\n';
  for (const [dir, count] of Object.entries(sourceDirs)) {
    output += `${dir}/ (${count} entries)\n`;
  }

  if (Object.keys(collapsed).length > 0) {
    output += '\nCollapsed:\n';
    for (const [dir, count] of Object.entries(collapsed)) {
      output += `- ${dir}: ${count} entries hidden\n`;
    }
  }

  const totalSource = Object.values(sourceDirs).reduce((a, b) => a + b, 0);
  let summary = `${totalSource} source entries shown.`;
  if (collapsedCount > 0) {
    summary += ` ${collapsedCount} entries in common dirs collapsed.`;
  }

  return {
    summary,
    importantOutput: output.trim(),
    omittedLines: collapsedCount,
  };
}

module.exports = { compressListOutput };
