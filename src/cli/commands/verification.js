const verification = require('../../verification'),
  USAGE = {
    'verify-scan': '[--base <ref>] [--path <repo dir>]  (exits 1 on high-severity bypass findings)',
    'verify-ingest':
      '--report <gnatprove output folder | results .json> [--format gnatprove|neutral] [--path <repo dir>]',
    'proof-state': '[--verifier NAME] [--path <repo dir>]',
    'capture-checks': '--command <shell command> --output <its output> [--path <cwd>]  (used by agent hooks)',
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
  commands['capture-checks'] = (args) =>
    verification.captureCheckOutput(deps, {
      cwd: str(args.path) || process.cwd(),
      command: str(args.command),
      output: str(args.output),
    });
}

module.exports = { register, USAGE };
