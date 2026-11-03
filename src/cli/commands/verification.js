const verification = require('../../verification'),
  USAGE = {
    'verify-scan': '[--base <ref>] [--path <repo dir>]  (exits 1 on high-severity bypass findings)',
  };

function register(commands) {
  commands['verify-scan'] = (args) =>
    verification.scanRepo({
      cwd: typeof args.path === 'string' ? args.path : process.cwd(),
      base: typeof args.base === 'string' ? args.base : 'HEAD',
    });
}

module.exports = { register, USAGE };
