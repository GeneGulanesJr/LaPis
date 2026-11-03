const verification = require('../../verification'),
  USAGE = {
    'verify-scan': '[--base <ref>] [--path <repo dir>]  (exits 1 on high-severity bypass findings)',
    'verify-ingest':
      '--report <gnatprove output folder | results .json> [--format gnatprove|neutral] [--path <repo dir>]',
    'proof-state': '[--verifier NAME] [--path <repo dir>]',
  };

const str = (v) => (typeof v === 'string' ? v : undefined);

function register(commands, deps) {
  commands['verify-scan'] = (args) =>
    verification.scanRepo({ cwd: str(args.path) || process.cwd(), base: str(args.base) || 'HEAD' });
  commands['verify-ingest'] = (args) =>
    verification.ingestReport(deps, {
      cwd: str(args.path) || process.cwd(),
      report: str(args.report),
      format: str(args.format),
    });
  commands['proof-state'] = (args) =>
    verification.proofState(deps, { cwd: str(args.path) || process.cwd(), verifier: str(args.verifier) });
}

module.exports = { register, USAGE };
